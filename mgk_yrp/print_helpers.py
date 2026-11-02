import base64

import frappe
from frappe.contacts.doctype.address.address import get_address_display
from frappe.utils import flt, formatdate
from yrp.party_addresses import get_party_address

from mgk_yrp.terminology.terms import get_tamil_labels, normalize
from mgk_yrp.web.preview import add_item_attributes

TITLE_FIELDS = {"Supplier": "supplier_name", "Warehouse": "warehouse_name", "MGK Agent": "agent_name"}
TAMIL_FONT = "MGK Noto Sans Tamil"


class PrintLabels(dict):
	"""Label lookup by English text (any case) that falls back to the English text."""

	def __getitem__(self, key):
		return super().get(normalize(key)) or key


def get_print_labels(tamil=0):
	"""Print labels from the editable MGK terminology when printing in Tamil."""
	return PrintLabels(get_tamil_labels() if tamil else {})


def get_print_name(doctype, name, tamil=0):
	"""Display name of a master; its `mgk_tamil_name` when printing in Tamil, falling back to English."""
	if not name:
		return ""
	if tamil and frappe.get_meta(doctype).has_field("mgk_tamil_name"):
		if tamil_name := frappe.get_cached_value(doctype, name, "mgk_tamil_name"):
			return tamil_name
	field = TITLE_FIELDS.get(doctype)
	return (field and frappe.get_cached_value(doctype, name, field)) or name


def get_print_items(doc, tamil=0):
	"""Item rows split into template item and one column per variant attribute, like the /web preview."""
	rows = add_item_attributes([row.as_dict() for row in doc.get("items") or []])
	for row in rows:
		row["item_label"] = get_print_name("Item", row["item_template"], tamil)
	child_meta = frappe.get_meta(doc.meta.get_field("items").options)
	return {
		"rows": rows,
		"attributes": list(dict.fromkeys(name for row in rows for name in row["item_attributes"])),
		"has_received_type": child_meta.has_field("received_type"),
		"total_qty": sum(flt(row.get("qty")) for row in rows),
		"total_amount": sum(flt(row.get("amount")) for row in rows),
	}


def get_print_date(value):
	return formatdate(value, "dd-mm-yyyy") if value else ""


def get_print_address(supplier, address=None):
	"""Rendered address of the given address, or of the supplier's default address."""
	address = address or get_party_address(supplier)
	return get_address_display(address) if address else ""


def get_print_company():
	return frappe.db.get_single_value("MGK Settings", "company") or ""


def get_tamil_font_face():
	"""Embedded @font-face rules so Tamil renders in the browser and in PDFs without a font server.

	`src` starts with local() so Frappe's PDF URL rewriting (which matches `: url(`) leaves the data URI intact.
	"""
	return frappe.cache.get_value("mgk_tamil_font_face", generator=build_tamil_font_face)


def build_tamil_font_face():
	rules = []
	for weight, style in ((400, "Regular"), (700, "Bold")):
		path = frappe.get_app_path("mgk_yrp", "public", "fonts", f"NotoSansTamil-{style}.ttf")
		with open(path, "rb") as font:
			data = base64.b64encode(font.read()).decode()
		rules.append(
			f'@font-face {{ font-family: "{TAMIL_FONT}"; font-weight: {weight}; '
			f'src: local("Noto Sans Tamil"), url("data:font/ttf;base64,{data}") format("truetype"); }}'
		)
	return "\n".join(rules)
