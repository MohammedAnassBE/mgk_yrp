import frappe
from frappe import _


@frappe.whitelist()
def get_link_summaries(doctype, names):
	if doctype not in ("Address", "Contact"):
		frappe.throw(_("Link summaries are only available for Addresses and Contacts."))
	frappe.has_permission(doctype, ptype="read", throw=True)
	if isinstance(names, str):
		names = frappe.parse_json(names)
	if not isinstance(names, list) or len(names) > 500 or any(not isinstance(name, str) for name in names):
		frappe.throw(_("Provide at most 500 document names."))
	if not names:
		return {}
	allowed = frappe.get_list(doctype, filters={"name": ["in", names]}, pluck="name", limit_page_length=0)
	if not allowed:
		return {}
	rows = frappe.get_all(
		"Dynamic Link", filters={"parenttype": doctype, "parentfield": "links", "parent": ["in", allowed]},
		fields=["parent", "link_doctype", "link_name"], order_by="idx asc", limit_page_length=0,
	)
	result = {name: [] for name in allowed}
	for row in rows:
		result[row.parent].append(f"{row.link_doctype}: {row.link_name}")
	return {name: " · ".join(values) for name, values in result.items()}
