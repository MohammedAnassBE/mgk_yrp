import math

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_reversal,
	validate_reversal_allowed,
)

from mgk_yrp.purchase.gst import apply_row_gst, get_gst_context, warn_missing_slabs
from mgk_yrp.purchase.revaluation import (
	create_invoice_adjustment,
	lock_invoice_sources,
	require_stock_adjustment,
)
from mgk_yrp.stock.ledger import validate_stock_dimensions
from mgk_yrp.stock.uom import copy_uom_snapshot, has_uom_snapshot, validate_uom_snapshot


class MGKPurchaseInvoice(Document):
	def onload(self):
		if self.docstatus == 2:
			self.set_onload(
				"valuation_pending",
				bool(
					frappe.get_all(
						"YRP Stock Valuation Adjustment",
						filters={
							"source_doctype": self.doctype,
							"source_name": self.name,
							"docstatus": 1,
							"status": ["not in", ["Completed", "Reversed"]],
						},
						limit_page_length=1,
					)
				),
			)

	def load_doc_before_save(self, *, raise_exception=False):
		if not self.is_new():
			self.lock_sources(previous=frappe.get_doc(self.doctype, self.name))
		super().load_doc_before_save(raise_exception=raise_exception)

	@property
	def linked_grns(self) -> list[str]:
		return sorted({row.goods_received_note for row in self.items if row.goods_received_note})

	def lock_sources(self, *, previous=None, wait=True):
		previous = previous or self.get_doc_before_save()
		names = self.linked_grns + (previous.linked_grns if previous else [])
		lock_invoice_sources(self, names, wait=wait)

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
		if not use_snapshot:
			warn_missing_slabs(self.items, self.tax_type)
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

	def sync_grn_links(self, current, *, wait=True):
		self.lock_sources(wait=wait)
		previous = self.get_doc_before_save()
		names = set(self.linked_grns + (previous.linked_grns if previous else []))
		for name in sorted(names):
			receipt = frappe.get_doc("MGK Goods Received Note", name, for_update=True)
			receipt.check_permission("read")
			if name in current:
				get_billable_grn(name, self.supplier, self.against, self.name)
				receipt.db_set("purchase_invoice", self.name, update_modified=False)
				receipt.notify_update()
			elif receipt.purchase_invoice == self.name:
				receipt.db_set("purchase_invoice", None, update_modified=False)
				receipt.notify_update()

	def before_submit(self):
		self.lock_sources()
		validate_stock_dimensions()
		require_stock_adjustment()

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
		self.ignore_linked_doctypes = (
			"MGK Goods Received Note",
			"YRP Stock Ledger Entry",
			"YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment",
			"YRP Stock Valuation Production Link",
		)

	def on_cancel(self):
		create_reversal(self.doctype, self.name)
		self.sync_grn_links([])
		self.onload()

	def on_trash(self):
		try:
			self.sync_grn_links([], wait=False)
		except frappe.QueryTimeoutError, frappe.QueryDeadlockError:
			frappe.throw(
				_("Purchase Invoice sources are busy; retry deleting this invoice."),
				exc=frappe.QueryTimeoutError,
			)


def validate_against(against):
	if against not in ("Purchase Order", "Job Work"):
		frappe.throw(_("Against must be Purchase Order or Job Work."))


def get_billable_grn(name, supplier=None, against=None, invoice=None):
	receipt = frappe.get_doc("MGK Goods Received Note", name, for_update=bool(invoice))
	receipt.check_permission("read")
	if receipt.docstatus != 1:
		frappe.throw(_("GRN {0} must be submitted.").format(name))
	validate_billing_link(receipt, invoice)
	if supplier and receipt.supplier != supplier:
		frappe.throw(_("GRN {0} must belong to the same supplier.").format(name))
	if against and cint(receipt.against_purchase_order) != int(against == "Purchase Order"):
		frappe.throw(_("GRN {0} does not match the invoice Against type.").format(name))
	return receipt


def validate_billing_link(receipt, invoice):
	locking_clause = "FOR UPDATE" if invoice else ""
	references = frappe.db.sql(
		f"""SELECT DISTINCT invoice.name FROM `tabMGK Purchase Invoice` invoice
		JOIN `tabMGK Purchase Invoice Item` item ON item.parent = invoice.name
		WHERE item.goods_received_note = %(grn)s AND invoice.docstatus < 2
			AND item.parenttype = 'MGK Purchase Invoice' AND item.parentfield = 'items'
			AND invoice.name != %(invoice)s ORDER BY invoice.name {locking_clause}""",
		{"grn": receipt.name, "invoice": invoice or ""},
		pluck=True,
	)
	billed_by = references[0] if references else receipt.purchase_invoice
	if billed_by and billed_by != invoice:
		frappe.throw(_("GRN {0} is already billed by Purchase Invoice {1}.").format(receipt.name, billed_by))


def get_unbilled_grn_filters(supplier=None, against=None) -> dict:
	filters = {"docstatus": 1, "purchase_invoice": ["is", "not set"]}
	if supplier:
		filters["supplier"] = supplier
	if against:
		validate_against(against)
		filters["against_purchase_order"] = int(against == "Purchase Order")
	return filters


@frappe.whitelist()
def get_unbilled_grns(supplier: str, against: str) -> list[dict]:
	validate_against(against)
	return frappe.get_list(
		"MGK Goods Received Note",
		filters=get_unbilled_grn_filters(supplier, against),
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
