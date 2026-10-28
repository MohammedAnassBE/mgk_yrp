from collections import defaultdict

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt
from yrp.stock.stock_ledger import enqueue_voucher_repost
from yrp.stock.utils import apply_posting_datetime

from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import get_linking_grns
from mgk_yrp.stock.backdating import validate_backdated_cancel, validate_backdated_posting
from mgk_yrp.stock.ledger import (
	assert_transfer_pairs,
	post_stock_entries,
	transfer_entries,
	validate_stock_dimensions,
)
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.stock.uom import (
	apply_independent_uom,
	copy_uom_snapshot,
	has_uom_snapshot,
	validate_uom_snapshot,
)
from mgk_yrp.stock.warehouse import get_supplier_warehouse


class MGKDeliveryChallan(Document):
	def load_doc_before_save(self, *, raise_exception=False):
		"""Lock source and return names before Frappe locks this challan."""
		if not self.is_new():
			previous = frappe.get_doc(self.doctype, self.name)
			self.lock_sources(previous=previous)
		super().load_doc_before_save(raise_exception=raise_exception)

	def before_validate(self):
		apply_posting_datetime(self)

	def validate(self):
		if bool(cint(self.is_return)) != bool(self.return_against):
			frappe.throw(_("A Return must specify Return Against; other Delivery Challans cannot."))
		self.set_warehouses()
		if self.is_return:
			self.set_return_rows(self.get_return_source())
		else:
			for row in self.items:
				if row.against_dc_item:
					frappe.throw(_("Only return rows can reference a Delivery Challan item."))
				apply_independent_uom(row)
		self.set_row_values()
		if self.docstatus == 0:
			self.close_status = ""
			self.delivery_challan_close = None

	def set_warehouses(self):
		if not self.to_warehouse:
			self.to_warehouse = get_supplier_warehouse(self.to_location)
		if self.from_warehouse and self.from_warehouse == self.to_warehouse:
			frappe.throw(_("From Warehouse and To Warehouse must be different."))

	@property
	def is_open(self) -> bool:
		return self.close_status == "Open"

	def validate_open(self, action: str) -> None:
		if not self.is_open:
			frappe.throw(
				_("Delivery Challan {0} is {1}; cannot {2}.").format(self.name, self.close_status, action)
			)

	def get_return_source(self, *, for_update=False):
		source = frappe.get_doc("MGK Delivery Challan", self.return_against, for_update=for_update)
		source.check_permission("read")
		if source.docstatus != 1 or source.is_return:
			frappe.throw(_("Return Against must be a submitted, non-return Delivery Challan."))
		source.validate_open(_("return"))
		self.validate_return_header(source)
		return source

	def validate_return_header(self, source):
		fields = {
			"from_location": source.to_location,
			"from_warehouse": source.to_warehouse,
			"to_location": source.from_location,
			"to_warehouse": source.from_warehouse,
			"process_name": source.process_name,
		}
		for fieldname, expected in fields.items():
			if self.get(fieldname) != expected:
				frappe.throw(_("Return {0} must mirror the original Delivery Challan.").format(fieldname))

	def set_return_rows(self, source):
		source_rows = {row.name: row for row in source.items}
		for row in self.items:
			original = source_rows.get(row.against_dc_item)
			if not original or original.item != row.item:
				frappe.throw(_("Row {0}: Item must map to a row of this Delivery Challan.").format(row.idx))
			if row.is_new() and not has_uom_snapshot(row):
				copy_uom_snapshot(row, original)
			validate_uom_snapshot(row, original, _("Delivery Challan"))
			copy_uom_snapshot(row, original)

	def set_row_values(self):
		for row in self.items:
			if flt(row.qty) <= 0 or flt(row.conversion_factor) <= 0:
				frappe.throw(_("Row {0}: Quantity and Conversion Factor must be positive.").format(row.idx))
			if flt(row.rate) < 0:
				frappe.throw(_("Row {0}: Declared Rate cannot be negative.").format(row.idx))
			row.stock_qty = flt(row.qty) * flt(row.conversion_factor)
			row.amount = flt(row.qty) * flt(row.rate)
			row.returned_qty = 0
		self.total_qty = sum(flt(row.qty) for row in self.items)
		self.total_declared_value = sum(flt(row.amount) for row in self.items)

	def lock_sources(self, *, previous=None):
		previous = previous or self.get_doc_before_save()
		lock_documents(
			{
				"MGK Delivery Challan": [
					self.return_against,
					previous.return_against if previous else None,
					self.name,
				]
			}
		)

	def before_submit(self):
		validate_stock_dimensions()
		self.lock_sources()
		if self.is_return:
			source = self.get_return_source(for_update=True)
			self.set_return_rows(source)
			self.set_row_values()
			self.validate_return_allowance(source)
		buckets = [(entry["item"], entry["warehouse"]) for entry in self.get_stock_entries()]
		validate_backdated_posting(self, buckets)

	def validate_return_allowance(self, source):
		returned = source.get_returned_stock_qty()
		for row in self.items:
			returned[row.against_dc_item] += flt(row.stock_qty)
		for row in source.items:
			if flt(returned[row.name] - flt(row.stock_qty), 6) > 0:
				frappe.throw(_("Row {0}: Return exceeds the remaining delivered quantity.").format(row.idx))

	def get_returned_stock_qty(self) -> dict[str, float]:
		rows = frappe.db.sql(
			"""
			SELECT item.against_dc_item, item.stock_qty
			FROM `tabMGK Delivery Challan Item` item
			JOIN `tabMGK Delivery Challan` dc ON dc.name = item.parent
			WHERE dc.return_against = %s AND dc.is_return = 1 AND dc.docstatus = 1
			ORDER BY dc.name, item.name FOR UPDATE
			""",
			(self.name,),
		)
		returned = defaultdict(float)
		for name, quantity in rows:
			returned[name] += flt(quantity)
		return returned

	def update_returned_qty(self):
		returned = self.get_returned_stock_qty()
		for row in self.items:
			row.db_set("returned_qty", returned[row.name], update_modified=False)

	def get_stock_entries(self) -> list[dict]:
		return [
			entry
			for row in self.items
			for entry in transfer_entries(
				self, row, from_warehouse=self.from_warehouse, to_warehouse=self.to_warehouse
			)
		]

	def on_submit(self):
		entries = self.get_stock_entries()
		post_stock_entries(entries)
		assert_transfer_pairs(self.doctype, self.name, expected_entries=entries)
		enqueue_voucher_repost(self)
		if self.is_return:
			self.get_return_source(for_update=True).update_returned_qty()
		else:
			self.db_set("close_status", "Open")

	def before_cancel(self):
		self.lock_sources()
		self.flags.for_update = True
		self.reload()
		self.docstatus = 2
		validate_stock_dimensions()
		if self.is_return:
			self.get_return_source(for_update=True)
		else:
			source = frappe.get_doc(self.doctype, self.name, for_update=True)
			source.validate_open(_("cancel"))
			source.validate_no_dependents()
		validate_backdated_cancel(self)
		self.ignore_linked_doctypes = (
			"YRP Stock Ledger Entry",
			"YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment",
		)

	def validate_no_dependents(self):
		if self.delivery_challan_close:
			frappe.throw(_("Reopen the Delivery Challan Close before cancelling this Delivery Challan."))
		if frappe.db.exists(self.doctype, {"return_against": self.name, "docstatus": ["<", 2]}):
			frappe.throw(
				_("Cancel or delete return Delivery Challans before cancelling this Delivery Challan.")
			)
		links = get_linking_grns(self.name, (0, 1))
		if links:
			frappe.throw(_("Cancel or delete linking Goods Received Note {0} first.").format(links[0]))

	def on_cancel(self):
		post_stock_entries(self.get_stock_entries(), cancel=True)
		enqueue_voucher_repost(self)
		if self.is_return:
			self.get_return_source(for_update=True).update_returned_qty()
		else:
			self.db_set("close_status", "")


@frappe.whitelist()
def make_delivery_challan_close(source_name: str) -> Document:
	frappe.has_permission("MGK Delivery Challan Close", "create", throw=True)
	lock_documents({"MGK Delivery Challan": [source_name]})
	target = frappe.new_doc("MGK Delivery Challan Close")
	target.delivery_challan = source_name
	target.validate()
	return target


@frappe.whitelist()
def make_return_delivery_challan(source_name: str) -> Document:
	frappe.has_permission("MGK Delivery Challan", "create", throw=True)
	lock_documents({"MGK Delivery Challan": [source_name]})
	source = frappe.get_doc("MGK Delivery Challan", source_name, for_update=True)
	source.check_permission("read")
	if source.docstatus != 1 or source.is_return:
		frappe.throw(_("Only submitted, non-return Delivery Challans can be returned."))
	source.validate_open(_("return"))
	target = frappe.new_doc("MGK Delivery Challan")
	target.update(
		{
			"is_return": 1,
			"return_against": source.name,
			"from_location": source.to_location,
			"from_warehouse": source.to_warehouse,
			"to_location": source.from_location,
			"to_warehouse": source.from_warehouse,
			"process_name": source.process_name,
		}
	)
	returned = source.get_returned_stock_qty()
	for row in source.items:
		remaining = flt(row.stock_qty) - returned[row.name]
		if flt(remaining, 6) > 0:
			item = target.append("items", {"item": row.item, "against_dc_item": row.name, "rate": row.rate})
			item.qty = remaining / flt(row.conversion_factor)
			copy_uom_snapshot(item, row)
	if not target.items:
		frappe.throw(_("This Delivery Challan has no remaining quantity to return."))
	apply_posting_datetime(target)
	target.set_row_values()
	return target
