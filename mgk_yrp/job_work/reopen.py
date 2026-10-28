import frappe
from frappe import _
from yrp.stock.stock_ledger import enqueue_voucher_repost, validate_stock_valuation_period
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_reversal,
	deactivate_production_links,
	validate_reversal_allowed,
)

from mgk_yrp.job_work.close_valuation import build_consumption_entries, lock_close_buckets
from mgk_yrp.stock.backdating import validate_backdated_cancel
from mgk_yrp.stock.ledger import post_stock_entries, validate_stock_dimensions
from mgk_yrp.stock.locking import lock_documents


def get_reopen_blockers(close) -> list[str]:
	blockers = []
	challan = frappe.get_doc("MGK Delivery Challan", close.delivery_challan, for_update=True)
	challan.check_permission("read")
	if challan.close_status != "Closed" or challan.delivery_challan_close != close.name:
		blockers.append(_("Delivery Challan must be Closed by this Close before reopening."))
	for check in (
		lambda: validate_reversal_allowed(close.doctype, close.name),
		lambda: validate_stock_valuation_period(close.posting_date, close.doctype, close.name),
		lambda: validate_backdated_cancel(close, for_update=True),
	):
		try:
			check()
		except (frappe.ValidationError, frappe.PermissionError) as error:
			blockers.append(str(error))
	blockers.extend(get_adjustment_blockers(close))
	return blockers


def get_adjustment_blockers(close) -> list[str]:
	blockers = []
	status = (
		frappe.db.get_value(
			"YRP Stock Valuation Adjustment", close.stock_valuation_adjustment, "status", for_update=True
		)
		if close.stock_valuation_adjustment
		else None
	)
	if status in ("Calculation Failed", "Apply Failed"):
		blockers.append(_("Resolve the Close valuation failure before reopening."))
	outputs = tuple(row.output_receipt_sle for row in close.outputs)
	if outputs and get_pending_output_adjustments(close, outputs):
		blockers.append(_("Another unfinished valuation owns an output receipt; wait before reopening."))
	consumptions = tuple(row.consumption_sle for row in close.items if row.consumption_sle)
	if consumptions and has_other_consumption_adjustment(close, consumptions):
		blockers.append(_("Consumption is used by another active Stock Valuation Adjustment."))
	return blockers


def get_pending_output_adjustments(close, outputs):
	return frappe.db.sql(
		"""
		SELECT DISTINCT adjustment.name
		FROM `tabYRP Stock Valuation Adjustment` adjustment
		JOIN `tabYRP Stock Valuation Adjustment Source` source ON source.parent = adjustment.name
		WHERE adjustment.docstatus = 1 AND source.target_sle IN %(outputs)s
			AND adjustment.name != %(own)s
			AND adjustment.status NOT IN ('Completed', 'Reversed')
		FOR UPDATE
		""",
		{"outputs": outputs, "own": close.stock_valuation_adjustment or ""},
	)


def has_other_consumption_adjustment(close, consumptions) -> bool:
	parameters = {"consumptions": consumptions, "own": close.stock_valuation_adjustment or ""}
	for table, relationship in (
		("YRP Stock Valuation Adjustment Source", "node.parent = adjustment.name"),
		("YRP Stock Valuation Propagation Entry", "node.adjustment = adjustment.name"),
	):
		if frappe.db.sql(
			f"""
			SELECT DISTINCT adjustment.name FROM `tabYRP Stock Valuation Adjustment` adjustment
			JOIN `tab{table}` node ON {relationship}
			WHERE adjustment.docstatus = 1 AND adjustment.name != %(own)s
				AND (node.source_sle IN %(consumptions)s OR node.target_sle IN %(consumptions)s)
				AND (adjustment.status NOT IN ('Completed', 'Reversed') OR
					(adjustment.status = 'Completed' AND COALESCE(adjustment.reversal_of, '') = ''))
			FOR UPDATE
			""",
			parameters,
		):
			return True
	return False


def lock_reopen(close):
	lock_documents({"MGK Delivery Challan": [close.delivery_challan]})
	close.lock_sources()
	challan = frappe.get_doc("MGK Delivery Challan", close.delivery_challan, for_update=True)
	challan.check_permission("read")
	validate_stock_dimensions()
	lock_close_buckets(challan)
	names = sorted(
		filter(
			None,
			[row.output_receipt_sle for row in close.outputs] + [row.consumption_sle for row in close.items],
		)
	)
	for name in names:
		frappe.db.sql("SELECT name FROM `tabYRP Stock Ledger Entry` WHERE name = %s FOR UPDATE", (name,))


def validate_reopen(close) -> None:
	lock_reopen(close)
	blockers = get_reopen_blockers(close)
	if blockers:
		frappe.throw("\n".join(blockers))


def start_reopen(close) -> None:
	create_reversal(close.doctype, close.name)
	close.db_set("reopen_status", "Reversing")
	frappe.db.set_value("MGK Delivery Challan", close.delivery_challan, "close_status", "Reopening")
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
	validate_backdated_cancel(close, for_update=True)
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
