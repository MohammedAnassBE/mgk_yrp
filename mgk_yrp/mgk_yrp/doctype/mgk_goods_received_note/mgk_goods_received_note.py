from collections import defaultdict

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt
from yrp.stock.stock_ledger import enqueue_voucher_repost
from yrp.stock.utils import apply_posting_datetime
from yrp.yrp.doctype.yrp_goods_received_note.yrp_goods_received_note import _po_excess_percentage

from mgk_yrp.job_work.grn_from_dc import (
	validate_output_route,
	validate_output_templates,
	validate_output_tracing,
	validate_process_name,
)
from mgk_yrp.stock import locking, transit
from mgk_yrp.stock.backdating import validate_backdated_cancel, validate_backdated_posting
from mgk_yrp.stock.dimensions import prepare_row_dimensions
from mgk_yrp.stock.item_editor import drop_zero_qty_rows, get_item_details, set_items_from_editor
from mgk_yrp.stock.ledger import post_stock_entries, receipt_entry, validate_stock_dimensions
from mgk_yrp.stock.uom import (
	apply_independent_uom,
	copy_uom_snapshot,
	has_uom_snapshot,
	validate_uom_snapshot,
)


class MGKGoodsReceivedNote(Document):
	def onload(self):
		self.set_onload("item_details", get_item_details(self))

	def load_doc_before_save(self, *, raise_exception=False):
		"""Lock source parents before Frappe locks this receipt."""
		if not self.is_new():
			previous = frappe.get_doc(self.doctype, self.name)
			self.lock_sources(previous=previous)
		super().load_doc_before_save(raise_exception=raise_exception)

	def before_validate(self):
		set_items_from_editor(self)
		drop_zero_qty_rows(self)
		prepare_row_dimensions(self)
		apply_posting_datetime(self)

	def before_update_after_submit(self):
		previous = self.get_doc_before_save()
		if self.purchase_invoice != previous.purchase_invoice:
			frappe.throw(
				_("Purchase Invoice is maintained by billing and cannot be changed on a submitted GRN.")
			)

	def validate(self):
		if self.against_purchase_order:
			order = self.validate_purchase_order()
			self.set_purchase_order_rows(order)
		else:
			self.set_job_work_rows()
		transit.set_internal_transfer(self)
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
		if self.delivery_challans:
			transit.reject_internal_action(self, _("link Delivery Challans"))
		previous = self.get_doc_before_save()
		names = self.linked_delivery_challans + (previous.linked_delivery_challans if previous else [])
		if names:
			locking.lock_documents({"MGK Delivery Challan": names})
		self.validate_removed_delivery_challan_links(previous)
		if self.against_purchase_order and self.delivery_challans:
			frappe.throw(_("A Purchase Order receipt cannot link Delivery Challans."))
		self.validate_current_delivery_challan_links()
		validate_process_name(self)
		validate_output_route(self)
		validate_output_templates(self)
		validate_output_tracing(self)

	def validate_removed_delivery_challan_links(self, previous) -> None:
		names = previous.linked_delivery_challans if previous else []
		for name in set(names) - set(self.linked_delivery_challans):
			challan = frappe.get_doc("MGK Delivery Challan", name, for_update=True)
			challan.check_permission("read")
			challan.validate_open(_("remove a GRN link"))

	def validate_current_delivery_challan_links(self) -> None:
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
		location = order.receipt_location
		self.delivery_location = location["location"]
		if not self.warehouse:
			self.warehouse = location["warehouse"]
		return order

	def set_purchase_order_rows(self, order):
		source_rows = {row.name: row for row in order.items}
		for row in self.items:
			if not row.purchase_order_item:
				row.purchase_order_item = find_purchase_order_row(order, row).name
			source = source_rows.get(row.purchase_order_item)
			if not source or source.item != row.item:
				frappe.throw(_("Row {0}: Item must map to a row of this Purchase Order.").format(row.idx))
			if row.is_new() and not has_uom_snapshot(row):
				copy_uom_snapshot(row, source)
			validate_uom_snapshot(row, source, _("Purchase Order"))
			row.rate = source.rate

	def set_row_values(self):
		for row in self.items:
			allow_zero = self.docstatus == 0 and (
				self.against_purchase_order or row.is_prefilled or not row.is_new()
			)
			invalid_qty = flt(row.qty) < 0 or (not allow_zero and flt(row.qty) == 0)
			if invalid_qty or flt(row.conversion_factor) <= 0:
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
		from mgk_yrp.job_work.dc_from_grn import get_linking_challans

		previous = previous or self.get_doc_before_save()
		documents = {"MGK Goods Received Note": [self.name]}
		orders = list(
			dict.fromkeys(filter(None, [self.purchase_order, previous.purchase_order if previous else None]))
		)
		if orders:
			documents["MGK Purchase Order"] = orders
		challans = self.linked_delivery_challans + (previous.linked_delivery_challans if previous else [])
		downstream = get_linking_challans([self.name]) if self.docstatus == 2 else []
		challans += downstream
		if challans:
			documents["MGK Delivery Challan"] = challans
		locking.lock_documents(documents)
		if self.docstatus == 2 and get_linking_challans([self.name], for_update=True) != downstream:
			frappe.throw(_("Stock dependencies changed; retry the operation."))

	def before_submit(self):
		validate_stock_dimensions()
		self.lock_sources()
		if self.against_purchase_order:
			order = self.validate_purchase_order(for_update=True)
			self.set_purchase_order_rows(order)
			self.validate_receipt_allowance(order)
		else:
			self.set_job_work_rows()
		transit.prepare_submission(self)
		self.validate_delivery_challan_links()
		self.set_row_values()
		validate_backdated_posting(self, [(row.item, transit.get_receiving_warehouse(self)) for row in self.items])

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
		return [receipt_entry(self, row, transit.get_receiving_warehouse(self)) for row in self.items]

	def on_submit(self):
		post_stock_entries(self.get_stock_entries())
		enqueue_voucher_repost(self)
		if self.against_purchase_order:
			frappe.get_doc("MGK Purchase Order", self.purchase_order, for_update=True).update_received_qty()

	def before_cancel(self):
		self.lock_sources()
		self.flags.for_update = True
		self.reload()
		self.docstatus = 2
		validate_stock_dimensions()
		invoice_name = frappe.db.get_value(self.doctype, self.name, "purchase_invoice", for_update=True)
		if invoice_name:
			status = frappe.db.get_value("MGK Purchase Invoice", invoice_name, "docstatus", for_update=True)
			if status is None:
				frappe.throw(
					_("Purchase Invoice {0} not found.").format(invoice_name), frappe.DoesNotExistError
				)
			if status < 2:
				frappe.throw(_("Cancel Purchase Invoice {0} before this receipt.").format(invoice_name))
		if self.against_purchase_order:
			frappe.get_doc("MGK Purchase Order", self.purchase_order, for_update=True).check_permission(
				"read"
			)
		challan = frappe.db.get_value(
			"MGK Delivery Challan",
			{"goods_received_note": self.name, "docstatus": 1},
			"name",
			for_update=True,
		)
		row_challans = frappe.db.sql(
			"""SELECT DISTINCT challan.name FROM `tabMGK Delivery Challan` challan
			JOIN `tabMGK Delivery Challan Item` detail ON detail.parent = challan.name
			WHERE challan.docstatus = 1 AND detail.goods_received_note = %s
				AND detail.parenttype = 'MGK Delivery Challan' AND detail.parentfield = 'items'
			ORDER BY challan.name FOR UPDATE""", (self.name,), pluck=True,
		)
		challan = challan or next(iter(row_challans), None)
		if challan:
			frappe.throw(_("Cancel Delivery Challan {0} before this receipt.").format(challan))
		self.validate_cancellable_delivery_challans()
		if self.is_internal_transfer:
			transit.cancel_completions(self)
		else:
			validate_backdated_cancel(self)
		self.ignore_linked_doctypes = (
			"YRP Stock Ledger Entry",
			"YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment",
			"YRP Stock Valuation Production Link",
			"MGK Delivery Challan Close",
			"MGK Delivery Challan",
			"YRP Stock Entry",
		)

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
		transit.clear_transfer_status(self)
		enqueue_voucher_repost(self)
		if self.against_purchase_order:
			frappe.get_doc("MGK Purchase Order", self.purchase_order, for_update=True).update_received_qty()


def find_purchase_order_row(order, row):
	matches = [source for source in order.items if source.item == row.item]
	if len(matches) != 1:
		frappe.throw(
			_("Row {0}: Expected exactly one Purchase Order row for item {1}; found {2}. Select a source row explicitly.").format(
				row.idx, row.item, len(matches)
			)
		)
	return matches[0]


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
