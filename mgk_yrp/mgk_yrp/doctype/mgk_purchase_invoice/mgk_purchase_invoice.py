import math

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_reversal,
	validate_reversal_allowed,
)

from mgk_yrp.purchase.gst import apply_row_gst, get_gst_context
from mgk_yrp.purchase.revaluation import create_invoice_adjustment
from mgk_yrp.stock.ledger import validate_stock_dimensions
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.stock.uom import copy_uom_snapshot, has_uom_snapshot, validate_uom_snapshot


class MGKPurchaseInvoice(Document):
	def load_doc_before_save(self, *, raise_exception=False):
		if not self.is_new():
			self.lock_sources(previous=frappe.get_doc(self.doctype, self.name))
		super().load_doc_before_save(raise_exception=raise_exception)

	@property
	def linked_grns(self) -> list[str]:
		return sorted({row.goods_received_note for row in self.items if row.goods_received_note})

	def lock_sources(self, *, previous=None):
		previous = previous or self.get_doc_before_save()
		names = self.linked_grns + (previous.linked_grns if previous else [])
		lock_documents({"MGK Goods Received Note": names, "MGK Purchase Invoice": [self.name]})

	def validate(self):
		validate_against(self.against)
		self.lock_sources()
		receipts = {
			name: get_billable_grn(name, self.supplier, self.against, self.name) for name in self.linked_grns
		}
		self.validate_full_grns(receipts)
		use_snapshot = not self.is_new() and frappe.db.get_value(self.doctype, self.name, "docstatus") == 1
		if not use_snapshot:
			self.update(get_gst_context(self.supplier))
		for row in self.items:
			source = next(
				item
				for item in receipts[row.goods_received_note].items
				if item.name == row.goods_received_note_item
			)
			self.set_source_row(row, source)
			apply_row_gst(row, self.tax_type, use_snapshot=use_snapshot)
		self.set_totals()

	def validate_full_grns(self, receipts):
		actual = [(row.goods_received_note, row.goods_received_note_item) for row in self.items]
		expected = {(receipt.name, row.name) for receipt in receipts.values() for row in receipt.items}
		if not actual or len(actual) != len(set(actual)) or set(actual) != expected:
			frappe.throw(_("Full-GRN billing is required: include every row exactly once."))

	def set_source_row(self, row, source):
		if row.item != source.item or flt(row.qty) != flt(source.qty):
			frappe.throw(
				_("Row {0}: Full-GRN billing requires the original item and quantity.").format(row.idx)
			)
		if row.is_new() and not has_uom_snapshot(row):
			copy_uom_snapshot(row, source)
		validate_uom_snapshot(row, source, _("Goods Received Note"))
		if not math.isfinite(flt(row.rate)) or flt(row.rate) < 0:
			frappe.throw(_("Row {0}: Rate must be a non-negative number.").format(row.idx))
		row.qty, row.stock_qty, row.grn_rate = source.qty, source.stock_qty, source.rate
		row.amount = flt(flt(row.qty) * flt(row.rate), 2)

	def set_totals(self):
		self.total_qty = sum(flt(row.qty) for row in self.items)
		for total, field in (
			("net_total", "amount"),
			("total_cgst", "cgst_amount"),
			("total_sgst", "sgst_amount"),
			("total_igst", "igst_amount"),
		):
			self.set(total, flt(sum(flt(row.get(field)) for row in self.items), 2))
		self.total_tax = flt(self.total_cgst + self.total_sgst + self.total_igst, 2)
		self.grand_total = flt(self.net_total + self.total_tax, 2)

	def on_update(self):
		self.sync_grn_links(self.linked_grns)

	def sync_grn_links(self, current):
		self.lock_sources()
		previous = self.get_doc_before_save()
		names = set(self.linked_grns + (previous.linked_grns if previous else []))
		for name in sorted(names):
			receipt = frappe.get_doc("MGK Goods Received Note", name, for_update=True)
			receipt.check_permission("read")
			if name in current:
				get_billable_grn(name, self.supplier, self.against, self.name)
				receipt.db_set("purchase_invoice", self.name, update_modified=False)
			elif receipt.purchase_invoice == self.name:
				receipt.db_set("purchase_invoice", None, update_modified=False)

	def before_submit(self):
		self.lock_sources()
		validate_stock_dimensions()

	@frappe.whitelist()
	def preview_taxes(self):
		self.check_permission("write")
		self.validate()

	def on_submit(self):
		create_invoice_adjustment(self)

	def before_cancel(self):
		self.lock_sources()
		validate_stock_dimensions()
		validate_reversal_allowed(self.doctype, self.name)
		previous = self.get_doc_before_save().as_dict()
		self.update({field.fieldname: previous.get(field.fieldname) for field in self.meta.fields})
		self.ignore_linked_doctypes = ("MGK Goods Received Note", "YRP Stock Valuation Adjustment")

	def on_cancel(self):
		create_reversal(self.doctype, self.name)
		self.sync_grn_links([])

	def on_trash(self):
		self.sync_grn_links([])


def validate_against(against):
	if against not in ("Purchase Order", "Job Work"):
		frappe.throw(_("Against must be Purchase Order or Job Work."))


def get_billable_grn(name, supplier=None, against=None, invoice=None):
	receipt = frappe.get_doc("MGK Goods Received Note", name, for_update=bool(invoice))
	receipt.check_permission("read")
	if receipt.docstatus != 1:
		frappe.throw(_("GRN {0} must be submitted.").format(name))
	if receipt.purchase_invoice and receipt.purchase_invoice != invoice:
		frappe.throw(
			_("GRN {0} is already billed by Purchase Invoice {1}.").format(name, receipt.purchase_invoice)
		)
	if supplier and receipt.supplier != supplier:
		frappe.throw(_("GRN {0} must belong to the same supplier.").format(name))
	if against and cint(receipt.against_purchase_order) != int(against == "Purchase Order"):
		frappe.throw(_("GRN {0} does not match the invoice Against type.").format(name))
	return receipt


@frappe.whitelist()
def get_unbilled_grns(supplier: str, against: str) -> list[dict]:
	validate_against(against)
	return frappe.get_list(
		"MGK Goods Received Note",
		filters={
			"supplier": supplier,
			"docstatus": 1,
			"purchase_invoice": ["is", "not set"],
			"against_purchase_order": int(against == "Purchase Order"),
		},
		fields=["name", "posting_date", "total_qty", "total_amount"],
		order_by="posting_date, name",
		limit_page_length=0,
	)


@frappe.whitelist()
def get_grn_rows(grn_names: list[str] | str) -> list[dict]:
	if isinstance(grn_names, str):
		grn_names = frappe.parse_json(grn_names)
	rows = []
	for name in sorted(set(grn_names)):
		receipt = get_billable_grn(name)
		for source in receipt.items:
			row = frappe._dict(
				goods_received_note=name,
				goods_received_note_item=source.name,
				item=source.item,
				qty=source.qty,
				grn_rate=source.rate,
				rate=source.rate,
			)
			copy_uom_snapshot(row, source)
			rows.append(row)
	return rows
