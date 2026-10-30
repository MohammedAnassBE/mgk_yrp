import frappe
from frappe import _


def validate(doc, method=None):
	if not doc.get("mgk_is_head_office"):
		return
	if not doc.get("is_company_location"):
		frappe.throw(_("A Head Office supplier must also be a Company Location."))
	other = frappe.db.get_value(
		"Supplier", {"mgk_is_head_office": 1, "name": ["!=", doc.name]}, "name", for_update=True
	)
	if other:
		frappe.throw(_("{0} is already the Head Office. Untick Is Head Office there first.").format(other))
