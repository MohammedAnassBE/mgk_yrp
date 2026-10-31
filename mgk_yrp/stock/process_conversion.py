import frappe
from frappe import _
from frappe.utils import flt
from yrp.yrp.doctype.yrp_item.yrp_item import get_parent_item


def validate_process_conversions(doc):
	rows = doc.get("mgk_process_conversions") or []
	if rows and not doc.has_variants:
		frappe.throw(
			_("Process Conversions can be set only on a template Item (Has Variants). Remove the rows first.")
		)
	seen = {}
	for row in rows:
		validate_conversion_row(doc, row)
		pair = (row.process_name, get_parent_item(row.item))
		if pair in seen:
			frappe.throw(
				_("Row {0}: Process {1} to Item {2} is already in row {3}.").format(
					row.idx, row.process_name, pair[1], seen[pair]
				)
			)
		seen[pair] = row.idx


def validate_conversion_row(doc, row):
	if flt(row.from_qty) <= 0 or flt(row.to_qty) <= 0:
		frappe.throw(_("Row {0}: From Qty and To Qty must be greater than zero.").format(row.idx))
	if not row.item:
		frappe.throw(_("Row {0}: Output Item is required.").format(row.idx))
	output = frappe.db.get_value("Item", row.item, ["name", "stock_uom", "variant_of"], as_dict=True)
	if not output:
		frappe.throw(_("Row {0}: Output Item {1} does not exist.").format(row.idx, row.item))
	if output.variant_of:
		frappe.throw(
			_("Row {0}: Output Item {1} is a variant. Select its template {2} or an Item without attributes.").format(
				row.idx, row.item, output.variant_of
			)
		)
	row.from_uom = doc.stock_uom
	row.to_uom = output.stock_uom


def get_process_conversion(item, process_name) -> list[dict]:
	"""Return a template's conversions with current Item UOMs."""
	template = get_parent_item(item)
	if not template:
		return []
	rows = frappe.get_all(
		"MGK Item Process Conversion",
		filters={
			"parent": template,
			"parenttype": "Item",
			"parentfield": "mgk_process_conversions",
			"process_name": process_name,
		},
		fields=["process_name", "item", "from_qty", "to_qty"],
		order_by="idx asc",
	)
	from_uom = frappe.db.get_value("Item", template, "stock_uom")
	for row in rows:
		row.from_uom = from_uom
		row.to_uom = frappe.db.get_value("Item", row.item, "stock_uom")
	return rows
