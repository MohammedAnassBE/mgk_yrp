from collections import defaultdict
from datetime import timedelta

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime
from yrp.stock.utils import get_combine_datetime, get_last_sle_rate

from mgk_yrp.stock.backdating import get_later_movement, validate_backdated_cancel
from mgk_yrp.stock.dimensions import copy_row_dimensions, validate_return_dimensions
from mgk_yrp.stock.ledger import assert_transfer_pairs, validate_stock_dimensions
from mgk_yrp.stock.locking import lock_documents, lock_stock_buckets
from mgk_yrp.stock.uom import copy_uom_snapshot

SOURCES = {
	"MGK Delivery Challan": ("DC Completion", "MGK Delivery Challan Item", "to_location"),
	"MGK Goods Received Note": ("GRN Completion", "MGK Goods Received Note Item", "delivery_location"),
}


def is_internal_route(origin, destination):
	if not origin or not destination or origin == destination:
		return False
	return all(
		cint(frappe.db.get_value("Supplier", location, "is_company_location"))
		for location in (origin, destination)
	)


def set_internal_transfer(source):
	origin = source.get("from_location") or source.get("supplier")
	destination = source.get(SOURCES[source.doctype][2])
	source.is_internal_transfer = int(
		not source.get("is_return") and is_internal_route(origin, destination)
	)
	if source.docstatus == 0:
		source.transit_warehouse = None
		source.transfer_status = ""
		for row in source.items:
			row.transferred_qty = 0
	validate_route_warehouses(source)


def get_transit_warehouse(*, shared_lock=False):
	if shared_lock:
		rows = frappe.db.sql(
			"""SELECT value FROM `tabSingles`
			WHERE doctype = %s AND field = %s LOCK IN SHARE MODE""",
			("YRP Stock Settings", "transit_warehouse"),
		)
		warehouse = rows[0][0] if rows else None
	else:
		warehouse = frappe.db.get_single_value("YRP Stock Settings", "transit_warehouse", cache=False)
	if not warehouse:
		frappe.throw(_("Set Transit Warehouse in YRP Stock Settings before submitting an internal transfer."))
	return warehouse


def validate_route_warehouses(source):
	transit = frappe.db.get_single_value("YRP Stock Settings", "transit_warehouse", cache=False)
	fields = ["from_warehouse", "to_warehouse", "warehouse"]
	if source.get("is_return") and source.get("return_against"):
		original = get_source("MGK Delivery Challan", source.return_against)
		if original.is_internal_transfer and source.from_warehouse == original.transit_warehouse:
			fields.remove("from_warehouse")
	warehouses = [source.get(field) for field in fields]
	if transit and transit in warehouses:
		frappe.throw(_("Transit Warehouse cannot be used as a source or destination warehouse."))


def get_return_warehouse(source):
	return source.transit_warehouse if source.get("is_internal_transfer") else source.to_warehouse


def validate_return_source(source):
	if not source.get("is_internal_transfer"):
		source.validate_open(_("return"))


def get_pending_quantities(source, *, exclude=None, transferred=None):
	if transferred is None:
		transferred = get_transferred_quantities(source, exclude=exclude) if source.get("is_internal_transfer") else defaultdict(float)
	returned = source.get_returned_stock_qty() if source.doctype == "MGK Delivery Challan" else defaultdict(float)
	return {row.name: flt(row.qty) - transferred[row.name] - returned[row.name] / flt(row.conversion_factor)
		for row in source.items}


def prepare_submission(source):
	set_internal_transfer(source)
	source.transit_warehouse = None
	source.transfer_status = ""
	for row in source.items:
		row.transferred_qty = 0
	if source.is_internal_transfer:
		source.transit_warehouse = get_transit_warehouse(shared_lock=True)
		source.transfer_status = "In Transit"
		if source.doctype == "MGK Delivery Challan":
			source.close_status = ""
			source.delivery_challan_close = None


def get_receiving_warehouse(source):
	if source.get("is_internal_transfer"):
		return source.get("transit_warehouse")
	return source.get("to_warehouse") or source.get("warehouse")


def reject_internal_action(source, action):
	if source.get("is_internal_transfer"):
		frappe.throw(_("{0} {1} is an internal transfer; cannot {2}.").format(source.doctype, source.name, action))


def get_source(doctype, name):
	if doctype not in SOURCES:
		frappe.throw(_("Complete Transfer supports only MGK Delivery Challan and MGK Goods Received Note."))
	lock_documents({doctype: [name]})
	source = frappe.get_doc(doctype, name, for_update=True)
	source.check_permission("read")
	return source


def validate_source(source):
	if source.docstatus != 1 or not source.get("is_internal_transfer"):
		frappe.throw(_("Complete Transfer requires a submitted internal transfer."))
	if source.transit_warehouse != get_transit_warehouse(shared_lock=True):
		frappe.throw(_("Transit Warehouse must match the warehouse stored on the source transfer."))
	validate_stock_dimensions()


def validate_destination(source, warehouse):
	if warehouse == source.transit_warehouse:
		frappe.throw(_("Transit Warehouse cannot be the completion destination."))
	destination = frappe.get_doc("Warehouse", warehouse)
	if destination.disabled or destination.is_group:
		frappe.throw(_("Receiving Warehouse must be enabled and non-group."))
	if destination.supplier != source.get(SOURCES[source.doctype][2]):
		frappe.throw(_("Receiving Warehouse must belong to the destination location."))


def get_transferred_quantities(source, *, exclude=None):
	rows = frappe.db.sql(
		"""SELECT detail.against_id_detail, SUM(detail.qty) AS qty
		FROM `tabYRP Stock Entry Detail` detail
		JOIN `tabYRP Stock Entry` entry ON entry.name = detail.parent
		WHERE entry.docstatus = 1 AND entry.against = %(doctype)s AND entry.against_id = %(name)s
			AND entry.purpose = %(purpose)s AND detail.against = %(child)s
			AND detail.parenttype = 'YRP Stock Entry' AND detail.parentfield = 'items'
			AND entry.name != %(exclude)s
		GROUP BY detail.against_id_detail FOR UPDATE""",
		{
			"doctype": source.doctype, "name": source.name,
			"purpose": SOURCES[source.doctype][0], "child": SOURCES[source.doctype][1],
			"exclude": exclude or "",
		},
	)
	return defaultdict(float, {name: flt(quantity) for name, quantity in rows})


@frappe.whitelist()
def complete_transfer(doctype, name, warehouse, items):
	for permission in ("create", "submit"):
		frappe.has_permission("YRP Stock Entry", permission, throw=True)
	source = get_source(doctype, name)
	validate_source(source)
	validate_destination(source, warehouse)
	requested = frappe.parse_json(items) if isinstance(items, str) else items
	entry = frappe.new_doc("YRP Stock Entry")
	entry.update({
		"purpose": SOURCES[doctype][0], "against": doctype, "against_id": name,
		"from_warehouse": source.transit_warehouse, "to_warehouse": warehouse,
	})
	for request in requested or []:
		if flt(request.get("qty")) == 0:
			continue
		append_completion_row(entry, source, request)
	if not entry.items:
		frappe.throw(_("Enter a positive quantity to complete the transfer."))
	entry.insert().submit()
	return entry.name


def append_completion_row(entry, source, request):
	original = next((row for row in source.items if row.name == request.get("name")), None)
	if not original:
		frappe.throw(_("Completion row must belong to the source transfer."))
	row = entry.append("items", {
		"item": original.item, "qty": flt(request.get("qty")),
		"against": SOURCES[source.doctype][1], "against_id_detail": original.name,
	})
	copy_row_dimensions(original, row)
	copy_uom_snapshot(row, original)


def validate_completion(entry, method=None):
	if entry.against not in SOURCES:
		validate_mislinked_rows(entry)
		return
	source = get_source(entry.against, entry.against_id)
	validate_source(source)
	if entry.purpose != SOURCES[source.doctype][0]:
		frappe.throw(_("Completion purpose must match the source document type."))
	if entry.from_warehouse != source.transit_warehouse:
		frappe.throw(_("Completion From Warehouse must match the stored Transit Warehouse."))
	validate_destination(source, entry.to_warehouse)
	validate_completion_time(entry, source, method)
	buckets = [(row.item, warehouse) for row in entry.items
		for warehouse in (entry.from_warehouse, entry.to_warehouse)]
	lock_stock_buckets(buckets)
	validate_inline_posting(entry, buckets)
	validate_completion_rows(entry, source)


def validate_mislinked_rows(entry):
	if any(row.against in {details[1] for details in SOURCES.values()} for row in entry.items):
		frappe.throw(_("MGK completion rows require the matching MGK source document."))


def validate_inline_posting(entry, buckets):
	posting = get_combine_datetime(entry.posting_date, entry.posting_time)
	later = get_later_movement(
		buckets, posting + timedelta(microseconds=1), (entry.doctype, entry.name), for_update=True
	)
	if later:
		frappe.throw(_("Resolve future stock entry {0} {1} before completing this transfer.").format(
			later.voucher_type, later.voucher_no
		))


def validate_completion_time(entry, source, method):
	if entry.get("set_posting_time") or entry.get("edit_posting_date_and_time"):
		frappe.throw(_("Completion entries must be posted at the current date and time."))
	# YRP stamps now in before_validate; before_submit must preserve that stamp.
	if method == "before_submit":
		if get_combine_datetime(entry.posting_date, entry.posting_time) != entry.flags.mgk_completion_time:
			frappe.throw(_("Completion posting date and time cannot be edited."))
	else:
		posting = now_datetime()
		entry.posting_date, entry.posting_time = posting.date(), posting.time()
		entry.flags.mgk_completion_time = posting
	if get_combine_datetime(entry.posting_date, entry.posting_time) < get_combine_datetime(
		source.posting_date, source.posting_time
	):
		frappe.throw(_("Completion cannot be posted before the source transfer."))


def validate_completion_rows(entry, source):
	originals = {row.name: row for row in source.items}
	requested = defaultdict(float)
	for row in entry.items:
		original = originals.get(row.against_id_detail)
		if row.against != SOURCES[source.doctype][1] or not original or row.item != original.item:
			frappe.throw(_("Completion rows must match an item row of the source transfer."))
		if flt(row.qty) <= 0:
			frappe.throw(_("Completion quantity must be positive."))
		validate_return_dimensions(row, original, source_label=source.doctype)
		copy_uom_snapshot(row, original)
		row.amount = flt(row.qty) * flt(row.rate)
		rate, matched = get_last_sle_rate(row.item, warehouse=source.transit_warehouse)
		row.allow_zero_valuation_rate = int(matched and flt(rate) == 0)
		requested[original.name] += flt(row.qty)
	validate_pending_quantities(source, requested, exclude=entry.name)
	entry.total_amount = sum(flt(row.amount) for row in entry.items)


def validate_pending_quantities(source, requested, *, exclude=None):
	pending = get_pending_quantities(source, exclude=exclude)
	for row in source.items:
		if flt(requested[row.name] - pending[row.name], 6) > 0:
			frappe.throw(_("Row {0}: Completion exceeds the pending quantity in transit.").format(row.idx))


def completion_submitted(entry, method=None):
	if entry.against in SOURCES:
		assert_transfer_pairs(entry.doctype, entry.name, expected_entries=entry.get_sl_entries())
		update_completion(entry)


def update_completion(entry, method=None):
	if entry.against not in SOURCES:
		return
	source = get_source(entry.against, entry.against_id)
	update_transfer_status(source)


def update_transfer_status(source):
	if not source.get("is_internal_transfer"):
		return
	transferred = get_transferred_quantities(source)
	pending = get_pending_quantities(source, transferred=transferred)
	for row in source.items:
		row.db_set("transferred_qty", transferred[row.name], update_modified=False)
	has_transferred = any(quantity > 0 for quantity in transferred.values())
	has_moved = any(flt(flt(row.qty) - pending[row.name], 6) > 0 for row in source.items)
	status = "In Transit"
	if all(flt(quantity, 6) <= 0 for quantity in pending.values()):
		status = "Transferred" if has_transferred else "Returned"
	elif has_moved:
		status = "Partly Transferred"
	source.db_set("transfer_status", status if source.docstatus == 1 else "", update_modified=False)
	source.notify_update()


def before_completion_cancel(entry, method=None):
	previous = entry.get_doc_before_save()
	if (previous or entry).against not in SOURCES:
		return
	entry.flags.for_update = True
	entry.reload()
	entry.docstatus = 2
	source = get_source(entry.against, entry.against_id)
	validate_source(source)
	if entry.from_warehouse != source.transit_warehouse:
		frappe.throw(_("Completion From Warehouse must match the stored Transit Warehouse."))
	buckets = [(row.item, warehouse) for row in entry.items
		for warehouse in (entry.from_warehouse, entry.to_warehouse)]
	validate_backdated_cancel(entry, buckets=buckets)


def cancel_completions(source):
	if source.get("is_internal_transfer"):
		get_transit_warehouse(shared_lock=True)
	checkpoint = f"transit_cancel_{frappe.generate_hash(length=10)}"
	frappe.db.savepoint(checkpoint)
	try:
		cancel_submitted_completions(source)
		validate_backdated_cancel(source)
	except Exception as error:
		if not is_transaction_aborted(error):
			frappe.db.rollback(save_point=checkpoint)
		raise
	frappe.db.release_savepoint(checkpoint)
	if source.get("is_internal_transfer"):
		source.transfer_status = ""
		for row in source.items:
			row.transferred_qty = 0


def is_transaction_aborted(error):
	return (
		isinstance(error, (frappe.QueryDeadlockError, frappe.QueryTimeoutError))
		or frappe.db.is_deadlocked(error) or frappe.db.is_timedout(error)
	)


def cancel_submitted_completions(source):
	if source.get("is_internal_transfer"):
		entries = frappe.get_all(
			"YRP Stock Entry",
			filters={"against": source.doctype, "against_id": source.name, "docstatus": 1},
			pluck="name", order_by="posting_date desc, posting_time desc, creation desc, name desc",
		)
		for name in entries:
			entry = frappe.get_doc("YRP Stock Entry", name, for_update=True)
			entry.ignore_linked_doctypes = (source.doctype,)
			entry.cancel()


def clear_transfer_status(source):
	if source.get("is_internal_transfer"):
		source.db_set("transfer_status", "", update_modified=False)


def validate_settings(settings, method=None):
	previous = frappe.db.get_single_value(
		"YRP Stock Settings", "transit_warehouse", cache=False, for_update=True
	)
	if settings.transit_warehouse == previous:
		return
	for doctype in SOURCES:
		transfers = frappe.db.sql(
			f"""SELECT source.name FROM `tab{doctype}` source
			WHERE source.docstatus = 1 AND source.is_internal_transfer = 1
				AND source.transit_warehouse = %s LIMIT 1 FOR UPDATE""",
			(previous,),
		)
		if transfers:
			frappe.throw(_("Cannot change Transit Warehouse while {0} {1} is submitted; cancel it first.").format(
				doctype, transfers[0][0]
			))
