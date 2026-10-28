import math

import frappe
from frappe import _
from frappe.utils import flt
from yrp.yrp.doctype.yrp_item.yrp_item import get_parent_item


def get_gst_context(supplier: str) -> frappe._dict:
	party = frappe.get_doc("Supplier", supplier)
	party.check_permission("read")
	settings = frappe.get_single("MGK Settings")
	settings.check_permission("read")
	context = frappe._dict(
		supplier_gstin=party.tax_id or "",
		company_gstin=settings.company_gstin or "",
		tax_type="No Tax",
	)
	if not context.supplier_gstin:
		return context
	if not context.company_gstin:
		frappe.throw(_("Company GSTIN is required in MGK Settings when the supplier has a GSTIN."))
	context.tax_type = "CGST + SGST" if context.supplier_gstin[:2] == context.company_gstin[:2] else "IGST"
	return context


def get_item_slab(item: str, tax_type: str) -> tuple[str | None, float]:
	parent = get_parent_item(item)
	slab_name = frappe.db.get_value("Item", parent, "mgk_gst_tax_slab") if parent else None
	if not slab_name:
		if tax_type != "No Tax":
			frappe.throw(_("Item {0}: set MGK GST Tax Slab because the supplier has a GSTIN.").format(item))
		return None, 0
	slab = frappe.get_doc("YRP Tax Slab", slab_name)
	slab.check_permission("read")
	try:
		rate = float(slab.percentage)
	except ValueError, TypeError:
		frappe.throw(_("GST slab {0}: percentage must be numeric and between 0 and 100.").format(slab_name))
	if not slab.enabled or not math.isfinite(rate) or not 0 <= rate <= 100:
		frappe.throw(_("GST slab {0} must be enabled with a percentage between 0 and 100.").format(slab_name))
	return slab_name, rate


def apply_row_gst(row, tax_type: str, *, use_snapshot=False) -> None:
	if not use_snapshot:
		row.gst_tax_slab, row.gst_rate = get_item_slab(row.item, tax_type)
	row.cgst_amount = row.sgst_amount = row.igst_amount = 0
	if tax_type == "CGST + SGST":
		row.cgst_amount = row.sgst_amount = flt(flt(row.amount) * flt(row.gst_rate) / 200, 2)
	elif tax_type == "IGST":
		row.igst_amount = flt(flt(row.amount) * flt(row.gst_rate) / 100, 2)
