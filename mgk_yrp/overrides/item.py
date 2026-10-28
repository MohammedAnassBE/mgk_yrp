import frappe
from frappe import _


def validate(doc, method=None):
	if doc.get("mgk_is_karigan") and doc.get("mgk_is_salavai_cone"):
		frappe.throw(_("An Item cannot be both Karigan and Salavai Cone."))
