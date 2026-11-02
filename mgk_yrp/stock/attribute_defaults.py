import frappe
from frappe import _
from yrp.yrp.doctype.yrp_item import yrp_item
from yrp.yrp.doctype.yrp_item.yrp_item import get_parent_item

from mgk_yrp.stock.attribute_values import search_item_attribute_values

DEFAULT_FIELD = "mgk_default_value"


def get_attribute_defaults(item):
	"""Default value per non-primary attribute of the Item's template."""
	template = frappe.get_cached_doc("Item", get_parent_item(item) or item)
	return {
		row.attribute: row.get(DEFAULT_FIELD)
		for row in template.get("attributes") or []
		if row.get(DEFAULT_FIELD) and row.attribute != template.primary_attribute
	}


@frappe.whitelist()
def get_attribute_details(item_name, dependent_attr_mapping=None):
	"""YRP attribute details plus the template's attribute defaults."""
	details = dict(yrp_item.get_attribute_details(item_name, dependent_attr_mapping))
	details["attribute_defaults"] = get_attribute_defaults(item_name)
	return details


@frappe.whitelist()
def get_item_attribute_defaults(item):
	frappe.get_cached_doc("Item", item).check_permission("read")
	return get_attribute_defaults(item)


@frappe.whitelist()
def search_default_values(txt="", attribute=None, item=None):
	"""Desk Autocomplete options for a template row's Default Value."""
	item = item if item and frappe.db.exists("Item", item) else None
	return [
		{"value": row["value"], "label": f"{row['value']} ({row['tamil']})" if row["tamil"] else row["value"]}
		for row in search_item_attribute_values(txt, attribute, item)
	]


def validate_default_values(doc):
	if doc.get("variant_of"):
		return
	for row in doc.get("attributes") or []:
		default = row.get(DEFAULT_FIELD)
		if not default:
			continue
		if row.attribute == doc.get("primary_attribute"):
			frappe.throw(_("Row {0}: the primary attribute {1} cannot have a Default Value.").format(row.idx, row.attribute))
		if default not in yrp_item._mapping_values(row):
			frappe.throw(_("Row {0}: {1} is not an allowed value of {2}.").format(row.idx, default, row.attribute))


def fill_defaults(template, values):
	"""The given attribute values with blanks filled from the template's defaults."""
	defaults = get_attribute_defaults(template)
	return {**values, **{attribute: value for attribute, value in defaults.items() if not values.get(attribute)}}


def fill_entry_defaults(groups):
	"""Fill editor entries' blank attributes from their template's defaults."""
	for group in groups:
		for entry in group.get("items") or []:
			entry["attributes"] = fill_defaults(entry["name"], entry.get("attributes") or {})
	return groups
