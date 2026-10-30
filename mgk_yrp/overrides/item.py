import frappe
from frappe import _

from mgk_yrp.stock.process_conversion import validate_process_conversions


def validate(doc, method=None):
	if doc.get("mgk_is_karigan") and doc.get("mgk_is_salavai_cone"):
		frappe.throw(_("An Item cannot be both Karigan and Salavai Cone."))
	validate_process_conversions(doc)
