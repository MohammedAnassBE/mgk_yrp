import frappe
from frappe import _
from yrp.stock.stock_ledger import enqueue_voucher_repost, validate_stock_valuation_period
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_reversal,
	deactivate_production_links,
	validate_reversal_allowed,
)

from mgk_yrp.job_work.close_valuation import build_consumption_entries
from mgk_yrp.job_work.dependencies import get_adjustment_blockers as get_dependency_adjustments
from mgk_yrp.job_work.dependencies import (
	get_close_blockers,
	get_downstream_blockers,
	get_independent_consumptions,
	lock_close_dependencies,
)
from mgk_yrp.stock.backdating import validate_backdated_cancel
from mgk_yrp.stock.ledger import post_stock_entries, validate_stock_dimensions


def get_reopen_blockers(close) -> list[str]:
	graph = lock_reopen(close)
	blockers = []
	challan = frappe.get_doc("MGK Delivery Challan", close.delivery_challan, for_update=True)
	challan.check_permission("read")
	if challan.close_status != "Closed" or challan.delivery_challan_close != close.name:
		blockers.append(_("Delivery Challan must be Closed by this Close before reopening."))
	blockers.extend(get_guard_blockers(close))
	blockers.extend(get_adjustment_blockers(close, graph=graph))
	return list(dict.fromkeys(blockers))


def get_guard_blockers(close) -> list[str]:
	blockers = []
	muted = frappe.flags.mute_messages
	frappe.flags.mute_messages = True
	try:
		for check in (
			lambda: validate_reversal_allowed(close.doctype, close.name),
			lambda: validate_stock_valuation_period(close.posting_date, close.doctype, close.name),
			lambda: validate_reopen_backdating(close),
		):
			try:
				check()
			except (frappe.ValidationError, frappe.PermissionError) as error:
				blockers.append(str(error))
	finally:
		frappe.flags.mute_messages = muted
	return blockers


def validate_reopen_backdating(close):
	validate_backdated_cancel(close, for_update=True, ignored_sles=get_independent_consumptions(close))


def get_adjustment_blockers(close, *, graph=None) -> list[str]:
	if graph is None and close.outputs:
		graph = lock_close_dependencies(close)
	closes = get_close_blockers(close, graph.outgoing.values()) if graph else {}
	blockers = get_valuation_failure_blockers(close)
	blockers.extend(get_downstream_blockers(close, graph=graph, close_blockers=closes))
	consumptions = tuple(row.consumption_sle for row in close.items if row.consumption_sle)
	if consumptions:
		blockers.extend(
			get_dependency_adjustments(
				close,
				consumptions,
				excluded_sources=closes,
			)
		)
	return list(dict.fromkeys(blockers))


def get_valuation_failure_blockers(close) -> list[str]:
	blockers = []
	status = (
		frappe.db.get_value(
			"YRP Stock Valuation Adjustment", close.stock_valuation_adjustment, "status", for_update=True
		)
		if close.stock_valuation_adjustment
		else None
	)
	if status in ("Calculation Failed", "Apply Failed"):
		blockers.append(
			_(
				"Resolve Close {0} valuation failure in Stock Valuation Adjustment {1} before reopening."
			).format(close.name, close.stock_valuation_adjustment)
		)
	return blockers


def lock_reopen(close):
	validate_stock_dimensions()
	return lock_close_dependencies(close)


def validate_reopen(close) -> None:
	blockers = get_reopen_blockers(close)
	if blockers:
		frappe.throw(blockers, as_list=True)


def start_reopen(close) -> None:
	create_reversal(close.doctype, close.name)
	close.db_set("reopen_status", "Reversing")
	frappe.db.set_value("MGK Delivery Challan", close.delivery_challan, "close_status", "Reopening")
	close.notify_update()
	frappe.get_doc("MGK Delivery Challan", close.delivery_challan).notify_update()
	if not close.stock_valuation_adjustment:
		complete_reopen(close)


@frappe.whitelist()
def finish_reopen(close_name: str) -> bool:
	close = frappe.get_doc("MGK Delivery Challan Close", close_name)
	close.check_permission("cancel")
	lock_reopen(close)
	close.flags.for_update = True
	close.reload()
	if close.reopen_status == "Reopened":
		return True
	if close.docstatus != 2 or close.reopen_status != "Reversing":
		frappe.throw(_("Only a cancelled Close awaiting reversal can finish reopening."))
	if not is_reversal_complete(close):
		return False
	complete_reopen(close)
	return True


def is_reversal_complete(close) -> bool:
	if not close.stock_valuation_adjustment:
		return True
	reversals = frappe.get_all(
		"YRP Stock Valuation Adjustment",
		filters={
			"reversal_of": close.stock_valuation_adjustment,
			"docstatus": 1,
		},
		pluck="status",
	)
	return bool(reversals) and all(status == "Completed" for status in reversals)


def complete_reopen(close) -> None:
	challan = frappe.get_doc("MGK Delivery Challan", close.delivery_challan, for_update=True)
	if challan.close_status != "Reopening" or challan.delivery_challan_close != close.name:
		frappe.throw(_("Delivery Challan is no longer reopening this Close."))
	validate_reopen_backdating(close)
	post_stock_entries(build_consumption_entries(close, close.items), cancel=True)
	deactivate_production_links(close.doctype, close.name)
	frappe.db.set_value(
		"MGK Delivery Challan",
		close.delivery_challan,
		{
			"close_status": "Open",
			"delivery_challan_close": None,
		},
	)
	close.db_set("reopen_status", "Reopened")
	close.notify_update()
	challan.reload()
	challan.notify_update()
	enqueue_voucher_repost(close)


def finish_pending_reopens() -> None:
	names = frappe.get_all(
		"MGK Delivery Challan Close",
		filters={
			"docstatus": 2,
			"reopen_status": "Reversing",
		},
		pluck="name",
		order_by="name",
	)
	for name in names:
		try:
			finish_reopen(name)
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(title=_("Delivery Challan reopen failed: {0}").format(name))
