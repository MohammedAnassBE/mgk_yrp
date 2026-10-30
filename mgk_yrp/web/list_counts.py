import json

import frappe
from frappe import _

MAX_FILTER_SETS = 20


def validate_filter_sets(doctype_filter_sets):
	if isinstance(doctype_filter_sets, str):
		try:
			doctype_filter_sets = json.loads(doctype_filter_sets)
		except (TypeError, ValueError):
			frappe.throw(_("Count filters must be a JSON list."), frappe.ValidationError)
	if not isinstance(doctype_filter_sets, list) or len(doctype_filter_sets) > MAX_FILTER_SETS:
		frappe.throw(_("Provide a list of at most 20 count filter sets."), frappe.ValidationError)
	for entry in doctype_filter_sets:
		if not isinstance(entry, dict):
			frappe.throw(_("Each count filter set must be an object."), frappe.ValidationError)
		if not isinstance(entry.get("doctype"), str) or not entry["doctype"].strip():
			frappe.throw(_("Each count filter set needs a DocType."), frappe.ValidationError)
		if not isinstance(entry.get("filters"), list):
			frappe.throw(_("Count filters must be a list."), frappe.ValidationError)
	return doctype_filter_sets


@frappe.whitelist()
def get_counts(doctype_filter_sets):
	entries = validate_filter_sets(doctype_filter_sets)
	for doctype in {entry["doctype"] for entry in entries}:
		if not frappe.has_permission(doctype, "read"):
			frappe.throw(_("Not permitted to read {0}.").format(doctype), frappe.PermissionError)
	counts = []
	for entry in entries:
		rows = frappe.get_list(
			entry["doctype"],
			filters=entry["filters"],
			fields=[{"COUNT": "*", "as": "count"}],
			limit=1,
			order_by="",
		)
		counts.append(int(rows[0].get("count") or 0) if rows else 0)
	return counts
