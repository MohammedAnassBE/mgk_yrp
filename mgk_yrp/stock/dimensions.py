import frappe
from yrp.stock.dimensions import apply_dimension_defaults, get_stock_dimensions


def prepare_row_dimensions(doc):
	apply_dimension_defaults(doc.items)
	if doc.doctype == "MGK Purchase Order":
		return
	for dimension in get_stock_dimensions():
		if dimension["mandatory"]:
			validate_required_dimension(doc.items, dimension)


def validate_required_dimension(rows, dimension):
	for row in rows:
		if not row.get(dimension["fieldname"]):
			frappe.throw(frappe._("Row {0}: {1} is required.").format(row.idx, dimension["label"]))


def get_dimension_defaults():
	row = {}
	apply_dimension_defaults([row])
	return row


def copy_row_dimensions(source, target):
	for dimension in get_stock_dimensions():
		fieldname = dimension["fieldname"]
		target.set(fieldname, source.get(fieldname))
	apply_dimension_defaults([target])


def validate_return_dimensions(row, source, *, source_label="Delivery Challan"):
	for dimension in get_stock_dimensions():
		fieldname = dimension["fieldname"]
		if (row.get(fieldname) or "") != (source.get(fieldname) or ""):
			frappe.throw(
				frappe._("Row {0}: {1} must match the original {2} row.").format(
					row.idx, dimension["label"], frappe._(source_label)
				)
			)
