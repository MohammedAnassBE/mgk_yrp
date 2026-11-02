import frappe
from frappe import _
from frappe.utils import cstr
from yrp.attribute_value_identity import attribute_value_name
from yrp.attribute_values import MASTER, ensure_value_master, get_mapping_document
from yrp.yrp.doctype.yrp_item import yrp_item
from yrp.yrp.doctype.yrp_item.yrp_item import get_parent_item, has_attribute_value

TAMIL_NAME = "mgk_tamil_name"
ALL_VALUES = 100000


@frappe.whitelist()
def search_item_attribute_values(txt="", attribute=None, item=None, page_len=99):
	"""The item's attribute values as `{value, tamil}`, matching the typed text in either language."""
	values = yrp_item.search_item_attribute_values("", attribute, item, ALL_VALUES)
	tamil = get_tamil_names(attribute, values)
	needle = cstr(txt).strip().lower()
	matches = [
		{"value": value, "tamil": tamil.get(value, "")}
		for value in values
		if needle in cstr(value).lower() or needle in tamil.get(value, "").lower()
	]
	if needle:
		matches.sort(
			key=lambda row: (
				cstr(row["value"]).lower() != needle,
				not cstr(row["value"]).lower().startswith(needle),
			)
		)
	return matches[: int(page_len or 99)]


def get_tamil_names(attribute, values):
	rows = frappe.get_all(
		MASTER,
		filters={
			"attribute_name": attribute,
			"attribute_value": ["in", values or [""]],
			TAMIL_NAME: ["is", "set"],
		},
		fields=["attribute_value", TAMIL_NAME],
	)
	return {row.attribute_value: row[TAMIL_NAME] for row in rows}


@frappe.whitelist(methods=["POST"])
def create_attribute_value(item, attribute, value, tamil_name=None):
	"""Create an attribute value if missing and make it selectable for the item."""
	value = cstr(value).strip()
	if not value:
		frappe.throw(_("Attribute value is required."))
	frappe.has_permission(MASTER, "create", throw=True)
	item_doc = frappe.get_doc("Item", get_parent_item(item) or item)
	item_doc.check_permission("read")
	row = next((row for row in item_doc.get("attributes") or [] if row.attribute == attribute), None)
	if not row:
		frappe.throw(_("{0} is not an attribute of Item {1}.").format(attribute, item_doc.name))
	ensure_attribute_value(attribute, value)
	set_tamil_name(attribute, value, cstr(tamil_name).strip())
	if row.mapping:
		add_to_mapping(item_doc, row.mapping, value)
	return value


def ensure_attribute_value(attribute, value):
	if frappe.db.exists(MASTER, attribute_value_name(attribute, value)):
		return
	if has_attribute_value(attribute, value):
		ensure_value_master(attribute, value)
		return
	frappe.get_doc({"doctype": MASTER, "attribute_name": attribute, "attribute_value": value}).insert()


def set_tamil_name(attribute, value, tamil_name):
	"""Fill the Tamil name of a value that has none; an existing Tamil name is kept."""
	name = attribute_value_name(attribute, value)
	if tamil_name and not frappe.db.get_value(MASTER, name, TAMIL_NAME):
		frappe.db.set_value(MASTER, name, TAMIL_NAME, tamil_name)


def add_to_mapping(item_doc, mapping_name, value):
	"""An empty mapping already allows every value, so only explicit lists grow."""
	mapping = get_mapping_document(mapping_name, for_update=True)
	values = [row.attribute_value for row in mapping.get("values") or []]
	if not values or value in values:
		return
	item_doc.check_permission("write")
	mapping.append("values", {"attribute_value": value})
	mapping.save(ignore_permissions=True)
