from collections import defaultdict

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt
from yrp.stock.stock_ledger import enqueue_voucher_repost
from yrp.stock.utils import apply_posting_datetime
from yrp.yrp.doctype.yrp_goods_received_note.yrp_goods_received_note import _po_excess_percentage

from mgk_yrp.stock import locking
from mgk_yrp.stock.backdating import validate_backdated_cancel, validate_backdated_posting
from mgk_yrp.stock.ledger import post_stock_entries, receipt_entry, validate_stock_dimensions
from mgk_yrp.stock.uom import (
	SNAPSHOT_FIELDS,
	apply_independent_uom,
	copy_uom_snapshot,
	validate_uom_snapshot,
)


class MGKGoodsReceivedNote(Document):
	def load_doc_before_save(self, *, raise_exception=False):
		"""Lock source parents before Frappe locks this receipt."""
		if not self.is_new():
			previous = frappe.get_doc(self.doctype, self.name)
			self.lock_sources(previous=previous)
		super().load_doc_before_save(raise_exception=raise_exception)

	def before_validate(self):
		apply_posting_datetime(self)

	def validate(self):
		if self.against_purchase_order:
			order = self.validate_purchase_order()
			self.set_purchase_order_rows(order)
		else:
			self.set_job_work_rows()
		self.validate_delivery_challan_links()
		self.set_row_values()

	def set_job_work_rows(self):
		self.purchase_order = None
		for row in self.items:
			if row.purchase_order_item:
				frappe.throw(
					_("Row {0}: A job-work receipt cannot reference a Purchase Order row.").format(row.idx)
				)
			apply_independent_uom(row)

	@property
	def linked_delivery_challans(self) -> list[str]:
		return list(
			dict.fromkeys(row.delivery_challan for row in self.delivery_challans if row.delivery_challan)
		)

	def validate_delivery_challan_links(self) -> None:
		previous = self.get_doc_before_save()
		names = self.linked_delivery_challans + (previous.linked_delivery_challans if previous else [])
		if names:
			locking.lock_documents({"MGK Delivery Challan": names})
		for name in set(names) - set(self.linked_delivery_challans):
			challan = frappe.get_doc("MGK Delivery Challan", name, for_update=True)
			challan.check_permission("read")
			challan.validate_open(_("remove a GRN link"))
		if self.against_purchase_order and self.delivery_challans:
			frappe.throw(_("A Purchase Order receipt cannot link Delivery Challans."))
		for name in self.linked_delivery_challans:
			challan = frappe.get_doc("MGK Delivery Challan", name, for_update=True)
			frappe.has_permission("MGK Delivery Challan", "read", doc=challan, throw=True)
			if challan.docstatus != 1 or challan.is_return:
				frappe.throw(_("Delivery Challan {0} must be submitted and non-return.").format(name))
			if challan.to_location != self.supplier:
				frappe.throw(
					_("Delivery Challan {0} must belong to the same supplier as this GRN.").format(name)
				)
			challan.validate_open(_("link"))

	def validate_purchase_order(self, *, for_update=False):
		if not self.purchase_order:
			frappe.throw(_("Purchase Order is required."))
		order = frappe.get_doc("MGK Purchase Order", self.purchase_order, for_update=for_update)
		order.check_permission("read")
		if order.docstatus != 1:
			frappe.throw(_("Purchase Order {0} must be submitted.").format(order.name))
		self.supplier = order.supplier
		self.delivery_location = order.delivery_location
		if not self.warehouse:
			self.warehouse = order.warehouse
		return order

	def set_purchase_order_rows(self, order):
		source_rows = {row.name: row for row in order.items}
		for row in self.items:
			source = source_rows.get(row.purchase_order_item)
			if not source or source.item != row.item:
				frappe.throw(_("Row {0}: Item must map to a row of this Purchase Order.").format(row.idx))
			if row.is_new() and not any(row.get(fieldname) for fieldname in SNAPSHOT_FIELDS):
				copy_uom_snapshot(row, source)
			validate_uom_snapshot(row, source, _("Purchase Order"))
			row.rate = source.rate

	def set_row_values(self):
		for row in self.items:
			if flt(row.qty) <= 0 or flt(row.conversion_factor) <= 0:
				frappe.throw(_("Row {0}: Quantity and Conversion Factor must be positive.").format(row.idx))
			self.validate_row_rate(row)
			row.stock_qty = flt(row.qty) * flt(row.conversion_factor)
			row.stock_rate = flt(row.rate) / flt(row.conversion_factor)
			row.amount = flt(row.qty) * flt(row.rate)
		self.total_qty = sum(flt(row.qty) for row in self.items)
		self.total_amount = sum(flt(row.amount) for row in self.items)

	def validate_row_rate(self, row):
		if self.against_purchase_order:
			if flt(row.rate) <= 0:
				frappe.throw(_("Row {0}: Purchase Order Rate must be positive.").format(row.idx))
			return
		if flt(row.rate) < 0:
			frappe.throw(_("Row {0}: Process charge Rate cannot be negative.").format(row.idx))
		row.allow_zero_valuation_rate = int(flt(row.rate) == 0)

	def lock_sources(self, *, previous=None):
		previous = previous or self.get_doc_before_save()
		documents = {"MGK Goods Received Note": [self.name]}
		orders = list(
			dict.fromkeys(filter(None, [self.purchase_order, previous.purchase_order if previous else None]))
		)
		if orders:
			documents["MGK Purchase Order"] = orders
		challans = self.linked_delivery_challans + (previous.linked_delivery_challans if previous else [])
		if challans:
			documents["MGK Delivery Challan"] = challans
		locking.lock_documents(documents)

	def before_submit(self):
		validate_stock_dimensions()
		self.lock_sources()
		if self.against_purchase_order:
			order = self.validate_purchase_order(for_update=True)
			self.set_purchase_order_rows(order)
			self.validate_receipt_allowance(order)
		else:
			self.set_job_work_rows()
		self.validate_delivery_challan_links()
		self.set_row_values()
		validate_backdated_posting(self, [(row.item, self.warehouse) for row in self.items])

	def validate_receipt_allowance(self, order):
		received = self.get_other_received_quantities()
		for row in self.items:
			received[row.purchase_order_item] += flt(row.qty)
		for source in order.items:
			limit = flt(source.qty) * (1 + _po_excess_percentage(source.item) / 100)
			if flt(received[source.name] - limit, 6) > 0:
				frappe.throw(
					_("Purchase Order row {0}: Receipt exceeds the allowed quantity {1}.").format(
						source.idx, limit
					)
				)

	def get_other_received_quantities(self):
		rows = frappe.db.sql(
			"""
			SELECT receipt_item.purchase_order_item, receipt_item.qty
			FROM `tabMGK Goods Received Note Item` receipt_item
			JOIN `tabMGK Goods Received Note` receipt ON receipt.name = receipt_item.parent
			WHERE receipt.docstatus = 1 AND receipt.against_purchase_order = 1
				AND receipt.purchase_order = %s AND receipt.name != %s
			FOR UPDATE
			""",
			(self.purchase_order, self.name),
		)
		received = defaultdict(float)
		for source_name, quantity in rows:
			received[source_name] += flt(quantity)
		return received

	def get_stock_entries(self) -> list[dict]:
		return [receipt_entry(self, row, self.warehouse) for row in self.items]

	def on_submit(self):
		post_stock_entries(self.get_stock_entries())
		enqueue_voucher_repost(self)
		if self.against_purchase_order:
			frappe.get_doc("MGK Purchase Order", self.purchase_order, for_update=True).update_received_qty()

	def before_cancel(self):
		validate_stock_dimensions()
		self.lock_sources()
		if self.against_purchase_order:
			frappe.get_doc("MGK Purchase Order", self.purchase_order, for_update=True).check_permission(
				"read"
			)
		self.validate_cancellable_delivery_challans()
		validate_backdated_cancel(self)
		self.ignore_linked_doctypes = (
			"YRP Stock Ledger Entry",
			"YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment",
		)
		if self.purchase_invoice:
			invoice = frappe.get_doc("MGK Purchase Invoice", self.purchase_invoice)
			invoice.check_permission("read")
			if invoice.docstatus < 2:
				frappe.throw(_("Cancel Purchase Invoice {0} before this receipt.").format(invoice.name))

	def validate_cancellable_delivery_challans(self):
		previous = self.get_doc_before_save()
		names = self.linked_delivery_challans + (previous.linked_delivery_challans if previous else [])
		for name in dict.fromkeys(names):
			challan = frappe.get_doc("MGK Delivery Challan", name, for_update=True)
			frappe.has_permission("MGK Delivery Challan", "read", doc=challan, throw=True)
			if not challan.is_open:
				frappe.throw(
					_("Delivery Challan {0} is closed; reopen it before cancelling this GRN.").format(name)
				)

	def on_cancel(self):
		post_stock_entries(self.get_stock_entries(), cancel=True)
		enqueue_voucher_repost(self)
		if self.against_purchase_order:
			frappe.get_doc("MGK Purchase Order", self.purchase_order, for_update=True).update_received_qty()


def get_linking_grns(delivery_challan: str, docstatus: tuple[int, ...], *, for_update=False) -> list[str]:
	if not docstatus:
		return []
	locking_clause = "FOR UPDATE" if for_update else ""
	return frappe.db.sql(
		f"""
		SELECT DISTINCT receipt.name FROM `tabMGK Goods Received Note` receipt
		JOIN `tabMGK GRN Delivery Challan` link ON link.parent = receipt.name
		WHERE link.delivery_challan = %(delivery_challan)s AND receipt.docstatus IN %(docstatus)s
			AND link.parenttype = 'MGK Goods Received Note' AND link.parentfield = 'delivery_challans'
		ORDER BY receipt.name {locking_clause}
		""",
		{"delivery_challan": delivery_challan, "docstatus": docstatus},
		pluck=True,
	)
