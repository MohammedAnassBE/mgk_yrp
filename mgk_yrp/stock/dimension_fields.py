import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
from yrp.stock.dimensions import assert_safe_fieldname, clear_dimension_cache, get_stock_dimensions

MANAGED_MARKER = "Managed by MGK Stock Dimension"
CHILD_DOCTYPES = (
	"MGK Purchase Order Item",
	"MGK Delivery Challan Item",
	"MGK Goods Received Note Item",
	"MGK Process Planning Item",
)


def sync_dimension_fields(doc=None, method=None):
	clear_dimension_cache()
	dimensions = get_stock_dimensions()
	fields = {}
	for doctype in CHILD_DOCTYPES:
		fields[doctype] = [dimension_field(dimension, doctype) for dimension in dimensions]
	if dimensions:
		create_custom_fields(fields, update=True)
	remove_orphan_fields({dimension["fieldname"] for dimension in dimensions})
	for doctype in CHILD_DOCTYPES:
		frappe.clear_cache(doctype=doctype)


def dimension_field(dimension, doctype):
	assert_safe_fieldname(dimension["fieldname"])
	return {
		"fieldname": dimension["fieldname"],
		"fieldtype": "Link",
		"options": dimension["dimension_doctype"],
		"label": dimension["label"],
		"reqd": 0 if doctype == "MGK Purchase Order Item" else int(dimension["mandatory"]),
		"insert_after": "item",
		"module": "YRP Stock",
		"description": MANAGED_MARKER,
	}


def remove_orphan_fields(current):
	fields = frappe.get_all(
		"Custom Field",
		filters={"dt": ["in", CHILD_DOCTYPES], "description": MANAGED_MARKER},
		fields=["name", "fieldname"],
	)
	for field in fields:
		if field.fieldname not in current:
			frappe.db.delete(
				"Custom Field",
				{"name": field.name, "dt": ["in", CHILD_DOCTYPES], "description": MANAGED_MARKER},
			)
