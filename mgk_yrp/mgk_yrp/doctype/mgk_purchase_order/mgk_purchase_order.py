import frappe
from frappe import _
from frappe.contacts.doctype.address.address import get_address_display
from frappe.contacts.doctype.contact.contact import get_contact_details, get_default_contact
from frappe.model.document import Document
from frappe.model.mapper import get_mapped_doc
from frappe.utils import cint, flt
from yrp.party_addresses import get_party_address
from yrp.stock.uom import resolve_item_uom
from yrp.stock.utils import apply_posting_datetime
from yrp.yrp.doctype.yrp_item.yrp_item import get_parent_item

from mgk_yrp.party_defaults import get_head_office
from mgk_yrp.purchase.receipt import PurchaseReceipt
from mgk_yrp.stock.dimensions import copy_row_dimensions, prepare_row_dimensions
from mgk_yrp.stock.item_editor import get_item_details, set_items_from_editor
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.stock.uom import apply_independent_uom, copy_uom_snapshot
from mgk_yrp.stock.warehouse import get_supplier_warehouse


class MGKPurchaseOrder(Document):
	def onload(self):
		self.set_onload("item_details", get_item_details(self))

	def before_validate(self):
		set_items_from_editor(self)
		prepare_row_dimensions(self)

	def validate(self):
		self.set_party_details()
		self.validate_delivery_location()
		self.set_default_warehouse()
		self.validate_goods_routing()
		self.validate_order_book()
		self.set_item_values()
		self.set_totals()
		if self.docstatus == 0:
			self.status = "Draft"

	def set_party_details(self):
		if not self.supplier:
			self.clear_party_details()
			return
		supplier = frappe.get_doc("Supplier", self.supplier)
		supplier.check_permission("read")
		if cint(supplier.is_company_location):
			frappe.throw(_("{0} is a company location; use a Delivery Challan to move stock between company locations.").format(self.supplier))
		if not self.has_supplier_link("Address", self.supplier_address):
			self.supplier_address = get_party_address(self.supplier)
		if not self.has_supplier_link("Contact", self.contact_person):
			self.contact_person = get_default_contact("Supplier", self.supplier)
		self.address_display = None
		if self.supplier_address:
			address = frappe.get_doc("Address", self.supplier_address)
			address.check_permission("read")
			self.address_display = get_address_display(address.as_dict())
		details = get_contact_details(self.contact_person) if self.contact_person else {}
		self.contact_display = details.get("contact_display")
		self.contact_mobile = details.get("contact_mobile")

	def clear_party_details(self):
		for fieldname in (
			"supplier_address",
			"address_display",
			"contact_person",
			"contact_display",
			"contact_mobile",
		):
			self.set(fieldname, None)

	def has_supplier_link(self, doctype, name):
		return bool(
			name
			and frappe.db.exists(
				"Dynamic Link",
				{
					"parenttype": doctype,
					"parent": name,
					"link_doctype": "Supplier",
					"link_name": self.supplier,
				},
			)
		)

	def set_default_warehouse(self):
		if not self.warehouse:
			self.warehouse = get_supplier_warehouse(self.delivery_location)

	def validate_delivery_location(self):
		if self.deliver_to_supplier and not self.process_name:
			frappe.throw(_("Process is required when Deliver to Supplier is ticked."))
		location = frappe.get_doc("Supplier", self.delivery_location)
		location.check_permission("read")
		if self.deliver_to_supplier and location.is_company_location:
			frappe.throw(_("Delivery Location {0} must not be a Company Location.").format(location.name))
		if not self.deliver_to_supplier and not location.is_company_location:
			frappe.throw(_("Delivery Location {0} must be a Company Location.").format(location.name))

	@property
	def receipt_location(self):
		if self.deliver_to_supplier:
			return get_head_office()
		return {"location": self.delivery_location, "warehouse": self.warehouse}

	def mark_as_received(self):
		return PurchaseReceipt(self).submit()

	def validate_goods_routing(self):
		if self.goods_routing == "Through Vendor" and not self.handling_supplier:
			frappe.throw(_("Handling Supplier is required when Goods Routing is 'Through Vendor'."))
		if self.goods_routing == "Direct":
			self.handling_supplier = None

	def validate_order_book(self):
		if self.is_karigan_order and self.is_salavai_cone_order:
			frappe.throw(_("A Purchase Order cannot belong to both the Karigan and Salavai Cone books."))
		for row in self.items:
			frappe.get_doc("Item", row.item).check_permission("read")
			parent = get_parent_item(row.item)
			if not parent:
				frappe.throw(_("Row {0}: Item {1} does not exist.").format(row.idx, row.item))
			item = frappe.get_cached_doc("Item", parent)
			item.check_permission("read")
			if not self.is_item_allowed(item):
				frappe.throw(
					_("Row {0}: Item {1} does not match the Purchase Order book.").format(row.idx, parent)
				)

	def is_item_allowed(self, item):
		if self.is_karigan_order:
			return bool(item.mgk_is_karigan)
		if self.is_salavai_cone_order:
			return bool(item.mgk_is_salavai_cone)
		return not item.mgk_is_karigan and not item.mgk_is_salavai_cone

	def set_item_values(self):
		for row in self.items:
			if flt(row.qty) <= 0 or flt(row.rate) <= 0:
				frappe.throw(_("Row {0}: Quantity and Rate must be greater than zero.").format(row.idx))
			apply_independent_uom(row)
			row.amount = flt(row.qty) * flt(row.rate)
			if self.docstatus == 0:
				row.received_qty = 0
				row.pending_qty = flt(row.qty)

	def set_totals(self):
		self.total_qty = sum(flt(row.qty) for row in self.items)
		self.total_amount = sum(flt(row.amount) for row in self.items)

	def before_submit(self):
		self.status = "To Receive"

	def on_cancel(self):
		self.db_set("status", "Cancelled", update_modified=False)
		self.notify_update()

	def before_cancel(self):
		lock_documents({self.doctype: [self.name]})
		challan = frappe.db.get_value(
			"MGK Delivery Challan",
			{"purchase_order": self.name, "docstatus": 1},
			["name", "goods_received_note"],
			as_dict=True,
			for_update=True,
		)
		if challan:
			frappe.throw(
				_("Cancel Delivery Challan {dc} first, then Goods Received Note {grn}.").format(
					dc=challan.name, grn=challan.goods_received_note
				)
			)
		receipts = frappe.db.sql(
			"""SELECT name FROM `tabMGK Goods Received Note`
			WHERE purchase_order = %s AND against_purchase_order = 1 AND docstatus = 1
			ORDER BY name FOR UPDATE""",
			(self.name,),
		)
		if receipts:
			frappe.throw(
				_("Cancel submitted Goods Received Notes first: {0}").format(
					", ".join(name for (name,) in receipts)
				)
			)
		self.ignore_linked_doctypes = ("MGK Goods Received Note", "MGK Delivery Challan")

	def update_received_qty(self) -> None:
		received = self.received_quantities
		for row in self.items:
			row.received_qty = flt(received.get(row.name))
			row.pending_qty = max(0, flt(row.qty) - row.received_qty)
			row.db_set(
				{"received_qty": row.received_qty, "pending_qty": row.pending_qty}, update_modified=False
			)
		self.db_set("status", self.receipt_status, update_modified=False)
		self.notify_update()

	@property
	def received_quantities(self):
		if not frappe.db.exists("DocType", "MGK Goods Received Note"):
			return {}
		return dict(
			frappe.db.sql(
				"""
			SELECT receipt_item.purchase_order_item, SUM(receipt_item.qty)
			FROM `tabMGK Goods Received Note Item` receipt_item
			JOIN `tabMGK Goods Received Note` receipt ON receipt.name = receipt_item.parent
			WHERE receipt.docstatus = 1 AND receipt.against_purchase_order = 1
				AND receipt.purchase_order = %s
			GROUP BY receipt_item.purchase_order_item
			FOR UPDATE
			""",
				(self.name,),
			)
		)

	@property
	def receipt_status(self):
		if self.docstatus == 2:
			return "Cancelled"
		if self.docstatus == 0:
			return "Draft"
		if all(flt(row.pending_qty) == 0 for row in self.items):
			return "Completed"
		if any(flt(row.received_qty) > 0 for row in self.items):
			return "Partially Received"
		return "To Receive"


@frappe.whitelist()
def mark_as_received(source_name: str) -> dict:
	return frappe.get_doc("MGK Purchase Order", source_name).mark_as_received()


@frappe.whitelist()
def get_item_uom(item: str) -> dict:
	frappe.get_doc("Item", item).check_permission("read")
	parent = get_parent_item(item)
	frappe.get_doc("Item", parent).check_permission("read")
	return resolve_item_uom(item)


@frappe.whitelist()
def make_goods_received_note(source_name: str) -> Document:
	order = frappe.get_doc("MGK Purchase Order", source_name)
	order.check_permission("read")
	order.flags.for_update = True
	order.reload()
	rows = {row.name: row for row in order.items}

	def set_pending_row(source, target, source_parent):
		current = rows[source.name]
		target.qty = flt(current.pending_qty)
		set_receipt_row(current, target, order)

	return get_mapped_doc(
		"MGK Purchase Order",
		source_name,
		{
			"MGK Purchase Order": {
				"doctype": "MGK Goods Received Note",
				"validation": {"docstatus": ["=", 1]},
				"field_map": {"name": "purchase_order"},
			},
			"MGK Purchase Order Item": {
				"doctype": "MGK Goods Received Note Item",
				"condition": lambda row: flt(rows[row.name].pending_qty) > 0,
				"field_map": {"name": "purchase_order_item", "pending_qty": "qty"},
				"postprocess": set_pending_row,
			},
		},
		postprocess=lambda source, target: set_receipt_header(order, target),
	)


def set_receipt_row(source, target, source_parent):
	copy_row_dimensions(source, target)
	copy_uom_snapshot(target, source)
	target.rate = source.rate
	target.stock_rate = flt(source.rate) / flt(source.conversion_factor)
	target.amount = flt(target.qty) * flt(target.rate)


def set_receipt_header(source, target):
	apply_posting_datetime(target)
	target.against_purchase_order = 1
	target.supplier = source.supplier
	location = source.receipt_location
	target.delivery_location = location["location"]
	target.warehouse = location["warehouse"]
	target.total_qty = sum(flt(row.qty) for row in target.items)
	target.total_amount = sum(flt(row.amount) for row in target.items)
	target.set_onload("item_details", get_item_details(target))
