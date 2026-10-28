import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime
from yrp.stock.utils import get_combine_datetime

from mgk_yrp.stock.locking import lock_stock_buckets


def is_backdated(doc) -> bool:
	return bool(
		doc.get("edit_posting_date_and_time")
		and get_combine_datetime(doc.posting_date, doc.posting_time) < now_datetime()
	)


def has_later_linked_movements(
	buckets: list[tuple[str, str]],
	posting_datetime,
	exclude_voucher: tuple[str, str],
	*,
	for_update=False,
	ignored_sles=(),
) -> bool:
	return has_later_movements(
		buckets,
		posting_datetime,
		exclude_voucher,
		linked_only=True,
		for_update=for_update,
		ignored_sles=ignored_sles,
	)


def has_later_movements(
	buckets, posting_datetime, exclude_voucher, *, linked_only=False, for_update=False, ignored_sles=()
) -> bool:
	return bool(
		get_later_movement(
			buckets,
			posting_datetime,
			exclude_voucher,
			linked_only=linked_only,
			for_update=for_update,
			ignored_sles=ignored_sles,
		)
	)


def get_later_movement(
	buckets, posting_datetime, exclude_voucher, *, linked_only=False, for_update=False, ignored_sles=()
):
	linked_condition = ""
	locking_clause = "FOR UPDATE" if for_update else ""
	ignored_condition = "AND sle.name NOT IN %(ignored_sles)s" if ignored_sles else ""
	if linked_only:
		linked_condition = f"""
		AND (
			(COALESCE(sle.paired_stock_ledger_entry, '') != '' AND sle.qty != 0)
			OR (sle.qty < 0 AND EXISTS (
				SELECT 1 FROM `tabYRP Stock Valuation Production Link` production
				WHERE production.consumption_sle = sle.name AND production.active = 1
				{locking_clause}
			))
		)
		"""
	for item, warehouse in sorted(set(buckets)):
		rows = frappe.db.sql(
			f"""
			SELECT sle.name, sle.voucher_type, sle.voucher_no FROM `tabYRP Stock Ledger Entry` sle
			WHERE sle.item = %(item)s AND sle.warehouse = %(warehouse)s AND sle.is_cancelled = 0
				AND sle.posting_datetime >= %(posting)s
				AND NOT (sle.voucher_type = %(doctype)s AND sle.voucher_no = %(name)s)
				{linked_condition} {ignored_condition}
			ORDER BY sle.posting_datetime DESC, sle.creation DESC, sle.name DESC
			LIMIT 1 {locking_clause}
			""",
			{
				"item": item,
				"warehouse": warehouse,
				"posting": get_datetime(posting_datetime),
				"doctype": exclude_voucher[0],
				"name": exclude_voucher[1],
				"ignored_sles": tuple(ignored_sles),
			},
			as_dict=True,
		)
		if rows:
			return rows[0]
	return None


def require_stock_manager(later=None) -> None:
	if "Stock Manager" not in frappe.get_roles():
		message = _("Backdated stock changes require the Stock Manager role.")
		if later:
			message += " " + _("Later entry: {0} {1}. Cancel newest entries first.").format(
				later.voucher_type, later.voucher_no
			)
		frappe.throw(message, frappe.PermissionError)


def validate_backdated_posting(doc, buckets) -> None:
	lock_stock_buckets(buckets)
	if not is_backdated(doc):
		return
	require_stock_manager()
	validate_linked_movements(doc, buckets, for_update=True)


def validate_linked_movements(doc, buckets, *, for_update=False, ignored_sles=()) -> None:
	posting_datetime = get_combine_datetime(doc.posting_date, doc.posting_time)
	later = get_later_movement(
		buckets,
		posting_datetime,
		(doc.doctype, doc.name),
		linked_only=True,
		for_update=for_update,
		ignored_sles=ignored_sles,
	)
	if later:
		frappe.throw(
			_(
				"Backdated stock changes are blocked by later linked movements: {0} {1}. "
				"Cancel newest entries first."
			).format(later.voucher_type, later.voucher_no)
		)


def validate_backdated_cancel(doc, *, buckets=None, for_update=True, ignored_sles=()) -> None:
	if buckets is None:
		buckets = [(entry["item"], entry["warehouse"]) for entry in doc.get_stock_entries()]
	lock_stock_buckets(buckets)
	posting_datetime = get_combine_datetime(doc.posting_date, doc.posting_time)
	later = get_later_movement(
		buckets, posting_datetime, (doc.doctype, doc.name), for_update=for_update, ignored_sles=ignored_sles
	)
	if later:
		require_stock_manager(later)
	validate_linked_movements(doc, buckets, for_update=for_update, ignored_sles=ignored_sles)
