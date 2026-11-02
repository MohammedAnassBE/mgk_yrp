import frappe


def set_company(doc, method=None):
	"""Stamp the MGK Settings company so letter heads can read doc.company."""
	if not doc.get("company"):
		doc.company = frappe.db.get_single_value("MGK Settings", "company")
