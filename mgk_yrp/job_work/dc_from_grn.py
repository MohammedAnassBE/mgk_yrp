from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import cint, flt
from yrp.stock.dimensions import get_dimension_fieldnames
from yrp.stock.utils import apply_posting_datetime, get_last_sle_rate

from mgk_yrp.party_defaults import get_head_office
from mgk_yrp.stock import transit
from mgk_yrp.stock.backdating import validate_backdated_cancel
from mgk_yrp.stock.dependencies import StockDependencies, get_grn_receipts, validate_reopening_closes
from mgk_yrp.stock.dimensions import copy_row_dimensions, validate_return_dimensions
from mgk_yrp.stock.ledger import assert_transfer_pairs, validate_stock_dimensions
from mgk_yrp.stock.locking import lock_documents, lock_stock_buckets
from mgk_yrp.stock.uom import copy_uom_snapshot
from mgk_yrp.stock.warehouse import get_supplier_warehouse


def get_receipt_names(challan):
	names = {row.goods_received_note for row in challan.items if row.goods_received_note}
	if challan.get("goods_received_note"):
		names.add(challan.goods_received_note)
	if challan.get("item_details"):
		from mgk_yrp.stock.item_editor import get_cells

		groups = frappe.parse_json(challan.item_details)
		names.update(cell["goods_received_note"] for cell in get_cells(groups) if cell and cell.get("goods_received_note"))
	return sorted(names)


def get_linking_challans(grn_names, *, for_update=False):
	if not grn_names:
		return []
	locking = "FOR UPDATE" if for_update else ""
	return frappe.db.sql(
		f"""SELECT DISTINCT challan.name FROM `tabMGK Delivery Challan` challan
		LEFT JOIN `tabMGK Delivery Challan Item` detail ON detail.parent = challan.name
			AND detail.parenttype = 'MGK Delivery Challan' AND detail.parentfield = 'items'
		WHERE challan.docstatus < 2 AND challan.is_return = 0
			AND (challan.goods_received_note IN %(receipts)s OR detail.goods_received_note IN %(receipts)s)
		ORDER BY challan.name {locking}""",
		{"receipts": tuple(sorted(set(grn_names)))}, pluck=True,
	)


def get_dispatched_quantities(grn_names, *, exclude=None):
	quantities = defaultdict(float)
	if not grn_names:
		return quantities
	rows = frappe.db.sql(
		"""SELECT detail.*, challan.goods_received_note AS header_receipt
		FROM `tabMGK Delivery Challan Item` detail
		JOIN `tabMGK Delivery Challan` challan ON challan.name = detail.parent
		WHERE challan.docstatus = 1 AND challan.is_return = 0 AND challan.name != %(exclude)s
			AND detail.parenttype = 'MGK Delivery Challan' AND detail.parentfield = 'items'
			AND (detail.goods_received_note IN %(receipts)s OR challan.goods_received_note IN %(receipts)s)
		ORDER BY challan.name, detail.idx FOR UPDATE""",
		{"receipts": tuple(sorted(set(grn_names))), "exclude": exclude or ""}, as_dict=True,
	)
	for row in rows:
		source = row.goods_received_note_item or get_legacy_receipt_row(row)
		quantities[source] += flt(row.qty)
	return quantities


def get_legacy_receipt_row(row):
	receipt = frappe.get_doc("MGK Goods Received Note", row.header_receipt)
	if not 0 < cint(row.idx) <= len(receipt.items):
		frappe.throw(_("Delivery Challan {0} has an invalid receipt row.").format(row.parent))
	source = receipt.items[row.idx - 1]
	if source.item != row.item:
		frappe.throw(_("Delivery Challan {0} has an invalid receipt row.").format(row.parent))
	validate_return_dimensions(row, source, source_label="Goods Received Note")
	return source.name


def get_source_receipt(row):
	if not row.goods_received_note or not row.goods_received_note_item:
		frappe.throw(_("Row {0}: Goods Received Note and its item row must both be set.").format(row.idx))
	receipt = frappe.get_doc("MGK Goods Received Note", row.goods_received_note)
	receipt.check_permission("read")
	if receipt.docstatus != 1:
		frappe.throw(_("Goods Received Note {0} must be submitted.").format(receipt.name))
	transit.reject_internal_action(receipt, _("create a Delivery Challan"))
	return receipt


def validate_dispatch_allowance(challan):
	if challan.is_return:
		return
	used = get_dispatched_quantities(get_receipt_names(challan), exclude=challan.name)
	for row in challan.items:
		if not row.goods_received_note_item:
			continue
		receipt = get_source_receipt(row)
		source = next(item for item in receipt.items if item.name == row.goods_received_note_item)
		used[source.name] += flt(row.qty)
		if flt(used[source.name] - flt(source.qty), 6) > 0:
			frappe.throw(_("Row {0}: quantity exceeds what is left on Goods Received Note {1}.").format(
				row.idx, receipt.name
			))


def stock_key(warehouse, row):
	return (warehouse, row.item, *(row.get(field) or "" for field in get_dimension_fieldnames()))


def get_moved_quantities(challan):
	quantities = defaultdict(float)
	names = frappe.get_all("YRP Stock Entry", filters={
		"mgk_delivery_challan": challan.name, "docstatus": 1,
	}, pluck="name", order_by="name")
	for name in names:
		entry = frappe.get_doc("YRP Stock Entry", name, for_update=True)
		if entry.to_warehouse != challan.from_warehouse or entry.purpose != "Send to Warehouse" or not entry.skip_transit:
			frappe.throw(_("Head Office move {0} must match the Delivery Challan route.").format(name))
		for row in entry.items:
			quantities[stock_key(entry.from_warehouse, row)] += flt(row.stock_qty)
	return quantities


def validate_head_office_move(challan):
	if challan.is_return:
		return
	moved = get_moved_quantities(challan)
	for row in challan.items:
		if not row.goods_received_note_item:
			continue
		receipt = get_source_receipt(row)
		if receipt.warehouse == challan.from_warehouse:
			continue
		key = stock_key(receipt.warehouse, row)
		moved[key] -= flt(row.stock_qty)
		if flt(moved[key], 6) < 0:
			frappe.throw(_("Row {0}: stock of Goods Received Note {1} is not at {2}.").format(
				row.idx, receipt.name, challan.from_warehouse
			))
	if any(flt(quantity, 6) for quantity in moved.values()):
		frappe.throw(_("Head Office move quantities must exactly match the Delivery Challan rows."))


@frappe.whitelist()
def make_delivery_challan_from_grns(source_names, process_name, supplier, move_to_head_office=0):
	names = source_names
	if isinstance(names, str):
		names = frappe.parse_json(names) if names.lstrip().startswith("[") else [names]
	if not isinstance(names, (list, tuple)) or not names or any(not isinstance(name, str) or not name for name in names):
		frappe.throw(_("Select at least one Goods Received Note."))
	receipts = [frappe.get_doc("MGK Goods Received Note", name) for name in dict.fromkeys(names)]
	return JobWorkDispatch(receipts, process_name, supplier, bool(cint(move_to_head_office))).submit()


def get_upstream_challans(names, *, for_update=False):
	locking = "FOR UPDATE" if for_update else ""
	return frappe.db.sql(
		f"""SELECT DISTINCT challan.name, challan.delivery_challan_close
		FROM `tabMGK Delivery Challan` challan
		JOIN `tabMGK GRN Delivery Challan` link ON link.delivery_challan = challan.name
		WHERE link.parent IN %(receipts)s AND link.parenttype = 'MGK Goods Received Note'
			AND link.parentfield = 'delivery_challans' ORDER BY challan.name {locking}""",
		{"receipts": tuple(sorted(names))},
	)


def validate_upstream_reopens(upstream):
	for _challan, close in upstream:
		if close and frappe.db.get_value("MGK Delivery Challan Close", close, "reopen_status", for_update=True) in ("Reopening", "Reversing"):
			frappe.throw(_("Finish reopening Close {0} before {1}.").format(close, _("creating a Delivery Challan")))


def lock_receipt_dependencies(names, documents):
	challans = get_linking_challans(names)
	upstream = get_upstream_challans(names)
	documents.setdefault("MGK Delivery Challan", []).extend([*challans, *(name for name, _close in upstream)])
	documents["MGK Goods Received Note"] = names
	documents["MGK Delivery Challan Close"] = [close for _name, close in upstream if close]
	graph = StockDependencies(get_grn_receipts(names), documents=documents).lock()
	current = (get_linking_challans(names, for_update=True), get_upstream_challans(names, for_update=True))
	if current != (challans, upstream) or set(get_grn_receipts(names, for_update=True)) != graph.receipts:
		frappe.throw(_("Stock dependencies changed; retry the operation."))
	validate_reopening_closes(graph, _("creating a Delivery Challan"))
	validate_upstream_reopens(upstream)


def lock_submission_sources(challan, previous=None):
	names = set(get_receipt_names(challan))
	if previous:
		names.update(get_receipt_names(previous))
	if not names:
		return
	orders = [challan.purchase_order, previous.purchase_order if previous else None]
	lock_receipt_dependencies(sorted(names), {
		"MGK Purchase Order": orders,
		"MGK Delivery Challan": [challan.name],
	})


class JobWorkDispatch:
	def __init__(self, receipts, process_name, supplier, move_to_head_office):
		self.receipts = receipts
		self.process_name = process_name
		self.supplier = supplier
		self.move_to_head_office = move_to_head_office

	def check_permissions(self):
		doctypes = ["MGK Delivery Challan"]
		if self.move_to_head_office:
			doctypes.append("YRP Stock Entry")
		for doctype in doctypes:
			for permission in ("create", "submit"):
				frappe.has_permission(doctype, permission, throw=True)
		for receipt in self.receipts:
			receipt.check_permission("read")

	def lock_sources(self):
		names = [receipt.name for receipt in self.receipts]
		lock_receipt_dependencies(names, {})
		for receipt in self.receipts:
			receipt.flags.for_update = True
			receipt.reload()

	def validate(self):
		validate_stock_dimensions()
		if not self.process_name:
			frappe.throw(_("Process is required."))
		frappe.get_doc("YRP Process", self.process_name).check_permission("read")
		supplier = frappe.get_doc("Supplier", self.supplier)
		supplier.check_permission("read")
		if supplier.disabled or supplier.is_company_location:
			frappe.throw(_("Select an enabled supplier that is not a Company Location."))
		for receipt in self.receipts:
			if receipt.docstatus != 1:
				frappe.throw(_("Goods Received Note {0} must be submitted.").format(receipt.name))
			transit.reject_internal_action(receipt, _("create a Delivery Challan"))
		warehouses = {receipt.warehouse for receipt in self.receipts}
		if len(warehouses) > 1 and not self.move_to_head_office:
			frappe.throw(_("Goods Received Notes are at different locations; tick Move stock to Head Office."))
		first = self.receipts[0]
		self.origin = get_head_office() if self.move_to_head_office else {
			"location": first.delivery_location or frappe.db.get_value("Warehouse", first.warehouse, "supplier"),
			"warehouse": first.warehouse,
		}
		self.destination = get_supplier_warehouse(self.supplier)
		if not self.destination:
			frappe.throw(_("Supplier {0} must have exactly one enabled warehouse.").format(self.supplier))

	def make_delivery_challan(self):
		challan = frappe.new_doc("MGK Delivery Challan")
		challan.update({
			"from_location": self.origin["location"], "from_warehouse": self.origin["warehouse"],
			"to_location": self.supplier, "to_warehouse": self.destination, "process_name": self.process_name,
		})
		used = get_dispatched_quantities([receipt.name for receipt in self.receipts])
		for receipt in self.receipts:
			for source in receipt.items:
				remaining = flt(source.qty) - used[source.name]
				if flt(remaining, 6) <= 0:
					continue
				row = challan.append("items", {
					"item": source.item, "qty": remaining, "rate": source.rate,
					"goods_received_note": receipt.name, "goods_received_note_item": source.name,
					"row_index": str(len(challan.items)), "table_index": 0,
				})
				copy_row_dimensions(source, row)
				copy_uom_snapshot(row, source)
		if not challan.items:
			frappe.throw(_("Selected Goods Received Notes have no remaining quantity to send."))
		apply_posting_datetime(challan)
		return challan

	def submit(self):
		self.check_permissions()
		self.lock_sources()
		self.check_permissions()
		self.validate()
		challan = self.make_delivery_challan()
		warehouses = {receipt.warehouse for receipt in self.receipts}
		warehouses.update((challan.from_warehouse, challan.to_warehouse))
		lock_stock_buckets((row.item, warehouse) for row in challan.items for warehouse in warehouses)
		checkpoint = f"job_work_dispatch_{frappe.generate_hash(length=10)}"
		frappe.db.savepoint(checkpoint)
		try:
			challan.insert()
			entries = self.move_stock(challan) if self.move_to_head_office else []
			challan.submit()
		except Exception as error:
			if not transit.is_transaction_aborted(error):
				frappe.db.rollback(save_point=checkpoint)
			raise
		frappe.db.release_savepoint(checkpoint)
		for receipt in self.receipts:
			receipt.notify_update()
		return {"delivery_challan": challan.name, "stock_entries": entries}

	def move_stock(self, challan):
		receipts = {receipt.name: receipt for receipt in self.receipts}
		entries = {}
		for source in challan.items:
			warehouse = receipts[source.goods_received_note].warehouse
			if warehouse == challan.from_warehouse:
				continue
			if warehouse not in entries:
				entry = frappe.new_doc("YRP Stock Entry")
				entry.update({
					"purpose": "Send to Warehouse", "skip_transit": 1, "mgk_delivery_challan": challan.name,
					"from_warehouse": warehouse, "to_warehouse": challan.from_warehouse,
				})
				entries[warehouse] = entry
			row = entries[warehouse].append("items", {
				"item": source.item, "qty": source.qty, "row_index": source.idx,
				"against": challan.doctype, "against_id_detail": challan.name,
			})
			copy_row_dimensions(source, row)
			copy_uom_snapshot(row, source)
		return [entry.insert().submit().name for entry in entries.values()]


def validate_head_office_move_entry(entry, method=None):
	if not entry.get("mgk_delivery_challan"):
		return
	challan = frappe.get_doc("MGK Delivery Challan", entry.mgk_delivery_challan)
	challan.lock_sources()
	challan.reload()
	challan.check_permission("read")
	validate_stock_dimensions()
	if challan.docstatus != 0 or challan.is_return or challan.is_internal_transfer:
		frappe.throw(_("Head Office moves require a draft, non-return job-work Delivery Challan."))
	if entry.purpose != "Send to Warehouse" or not cint(entry.skip_transit) or entry.against:
		frappe.throw(_("Head Office moves require Send to Warehouse with Skip Transit."))
	if entry.to_warehouse != challan.from_warehouse or entry.to_warehouse != get_head_office()["warehouse"]:
		frappe.throw(_("Head Office move destination must match the Delivery Challan."))
	transit.validate_completion_time(entry, challan, method)
	buckets = [(row.item, warehouse) for row in entry.items
		for warehouse in (entry.from_warehouse, entry.to_warehouse)]
	lock_stock_buckets(buckets)
	transit.validate_inline_posting(entry, buckets)
	validate_move_rows(entry, challan)


def validate_move_rows(entry, challan):
	sources = {row.idx: row for row in challan.items}
	requested = defaultdict(float)
	for row in entry.items:
		source = sources.get(cint(row.row_index))
		if (not source or source.item != row.item or row.against != challan.doctype
			or row.against_id_detail != challan.name or not source.goods_received_note_item):
			frappe.throw(_("Head Office move rows must match the Delivery Challan rows."))
		receipt = get_source_receipt(source)
		if receipt.warehouse != entry.from_warehouse or entry.from_warehouse == entry.to_warehouse:
			frappe.throw(_("Head Office move source must match the Goods Received Note warehouse."))
		validate_return_dimensions(row, source, source_label="Goods Received Note")
		copy_uom_snapshot(row, source)
		row.amount = flt(row.qty) * flt(row.rate)
		rate, matched = get_last_sle_rate(row.item, warehouse=entry.from_warehouse)
		row.allow_zero_valuation_rate = int(matched and flt(rate) == 0)
		requested[source.idx] += flt(row.qty)
	validate_move_quantities(entry, challan, requested)
	entry.total_amount = sum(flt(row.amount) for row in entry.items)


def validate_move_quantities(entry, challan, requested):
	existing = frappe.db.exists("YRP Stock Entry", {
		"mgk_delivery_challan": challan.name, "docstatus": 1,
		"from_warehouse": entry.from_warehouse, "name": ["!=", entry.name],
	})
	if existing:
		frappe.throw(_("Head Office move {0} already covers this warehouse.").format(existing))
	for source in challan.items:
		if not source.goods_received_note_item:
			continue
		receipt = get_source_receipt(source)
		if receipt.warehouse == entry.from_warehouse and flt(requested[source.idx] - flt(source.qty), 6):
			frappe.throw(_("Head Office move quantity must match the Delivery Challan rows."))


def head_office_move_submitted(entry, method=None):
	if entry.get("mgk_delivery_challan"):
		assert_transfer_pairs(entry.doctype, entry.name, expected_entries=entry.get_sl_entries())


def validate_head_office_move_cancel(entry, method=None):
	previous = entry.get_doc_before_save()
	name = (previous or entry).get("mgk_delivery_challan")
	if not name:
		return
	if frappe.db.get_value("MGK Delivery Challan", name, "docstatus", for_update=True) == 1:
		frappe.throw(_("Cancel Delivery Challan {0} first.").format(name))
	entry.flags.for_update = True
	entry.reload()
	entry.docstatus = 2
	buckets = [(row.item, warehouse) for row in entry.items
		for warehouse in (entry.from_warehouse, entry.to_warehouse)]
	validate_backdated_cancel(entry, buckets=buckets)


def get_head_office_moves(challans, *, for_update=False):
	if not challans:
		return []
	locking = "FOR UPDATE" if for_update else ""
	return frappe.db.sql(
		f"""SELECT name FROM `tabYRP Stock Entry`
		WHERE mgk_delivery_challan IN %(challans)s AND docstatus < 2 ORDER BY name {locking}""",
		{"challans": tuple(sorted(challans))}, pluck=True,
	)


def lock_head_office_move_sources(entry, previous):
	names = sorted(set(filter(None, [entry.get("mgk_delivery_challan"), previous.get("mgk_delivery_challan")])))
	if not names:
		return
	moves = get_head_office_moves(names)
	lock_documents({"MGK Delivery Challan": names, "YRP Stock Entry": [*moves, entry.name]})
	current = frappe.db.get_value(entry.doctype, entry.name, "mgk_delivery_challan", for_update=True)
	if current != previous.get("mgk_delivery_challan") or get_head_office_moves(names, for_update=True) != moves:
		frappe.throw(_("Stock dependencies changed; retry the operation."))


def cancel_head_office_moves(challan):
	names = frappe.get_all("YRP Stock Entry", filters={
		"mgk_delivery_challan": challan.name, "docstatus": 1,
	}, pluck="name", order_by="posting_date desc, posting_time desc, creation desc, name desc")
	for name in names:
		entry = frappe.get_doc("YRP Stock Entry", name, for_update=True)
		entry.ignore_linked_doctypes = (challan.doctype,)
		entry.cancel()
