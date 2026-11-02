import base64

import frappe
from frappe.contacts.doctype.address.address import get_address_display
from frappe.utils import flt, formatdate
from yrp.party_addresses import get_party_address

from mgk_yrp.web.preview import add_item_attributes

TITLE_FIELDS = {"Supplier": "supplier_name", "Warehouse": "warehouse_name", "MGK Agent": "agent_name"}
TAMIL_FONT = "MGK Noto Sans Tamil"
TAMIL_LABELS = {
	"PURCHASE ORDER": "கொள்முதல் ஆணை",
	"DELIVERY CHALLAN": "டெலிவரி சலான்",
	"RETURN DELIVERY CHALLAN": "திருப்பு டெலிவரி சலான்",
	"GOODS RECEIVED NOTE": "பொருள் வரவு குறிப்பு",
	"DRAFT": "வரைவு",
	"CANCELLED": "ரத்து",
	"To": "பெறுநர்",
	"From": "அனுப்புநர்",
	"Supplier": "சப்ளையர்",
	"Deliver To": "டெலிவரி இடம்",
	"Received At": "பெறப்பட்ட இடம்",
	"Warehouse": "கிடங்கு",
	"Contact": "தொடர்பு",
	"No.": "எண்",
	"Date": "தேதி",
	"Process": "செயல்முறை",
	"Item Group": "பொருள் குழு",
	"Routing": "வழித்தடம்",
	"Agent": "முகவர்",
	"Internal Transfer": "உள் பரிமாற்றம்",
	"DC No.": "டிசி எண்",
	"Vehicle No.": "வாகன எண்",
	"PO": "கொள்முதல் ஆணை",
	"GRN": "பொருள் வரவு",
	"DC": "டிசி",
	"Invoice": "பில்",
	"Return Against": "திருப்பு அடிப்படை",
	"Particulars": "விவரங்கள்",
	"S.No.": "வ.எண்",
	"Item": "பொருள்",
	"Received Type": "வரவு வகை",
	"Qty": "அளவு",
	"UOM": "அலகு",
	"Rate": "விலை",
	"Amount": "தொகை",
	"Value": "மதிப்பு",
	"Total": "மொத்தம்",
	"In Words": "எழுத்தில்",
	"Comments": "குறிப்புகள்",
	"Receiver's Signature": "பெறுநர் கையொப்பம்",
	"Supplier's Acceptance": "சப்ளையர் ஒப்புதல்",
	"Received By": "பெற்றவர்",
	"Prepared By": "தயாரித்தவர்",
	"For": "சார்பாக",
	"Authorised Signatory": "அங்கீகரிக்கப்பட்ட கையொப்பம்",
	"Printed on": "அச்சிட்ட நேரம்",
	"by": "அச்சிட்டவர்",
}


class PrintLabels(dict):
	"""Label lookup that falls back to the English text."""

	def __missing__(self, key):
		return key


def get_print_labels(tamil=0):
	return PrintLabels(TAMIL_LABELS if tamil else {})


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
