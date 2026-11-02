from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import cstr

from mgk_yrp.web.activity import get_version_page

PURCHASE_ORDER = "MGK Purchase Order"
RECEIPT = "MGK Goods Received Note"
CHALLAN = "MGK Delivery Challan"
INVOICE = "MGK Purchase Invoice"
CLOSE = "MGK Delivery Challan Close"
PLAN = "MGK Process Planning"
CREDIT_DEBIT = "MGK Supplier Credit Debit"
ALLOWED_DOCTYPES = {PURCHASE_ORDER, RECEIPT, CHALLAN, INVOICE, CLOSE, CREDIT_DEBIT}


@frappe.whitelist()
def get_preview(doctype: str, name: str) -> dict:
	if doctype not in ALLOWED_DOCTYPES:
		frappe.throw(_("Preview is not available for {0}.").format(doctype))
	frappe.has_permission(doctype, "read", doc=name, throw=True)
	doc = frappe.get_doc(doctype, name)
	doc.run_method("onload")
	doc.apply_fieldlevel_read_permissions()
	connections, linked_events = get_connections(doc)
	return {
		"doc": get_preview_doc(doc),
		"is_submittable": int(doc.meta.is_submittable),
		"items": get_preview_items(doc),
		"connections": connections,
		"timeline": get_timeline(doc, linked_events),
		"extra": get_extra(doc),
	}


def get_preview_items(doc):
	if doc.doctype == CLOSE:
		return [row.as_dict() for row in doc.get("outputs") or []]
	return add_item_attributes([row.as_dict() for row in doc.get("items") or []])


def add_item_attributes(rows):
	"""Set each row's template item and variant attribute values for the split preview columns."""
	names = list({row.get("item") for row in rows if row.get("item")})
	templates, attributes = get_item_templates(names), defaultdict(dict)
	for value in frappe.get_all(
		"Item Variant Attribute",
		filters={"parent": ["in", names or [""]], "parenttype": "Item", "parentfield": "attributes"},
		fields=["parent", "attribute", "attribute_value"],
		order_by="idx asc",
	):
		if value.attribute_value:
			attributes[value.parent][value.attribute] = value.attribute_value
	for row in rows:
		item = row.get("item")
		row["item_template"] = templates.get(item) or item
		row["item_attributes"] = attributes.get(item, {})
	return rows


def get_item_templates(names):
	rows = frappe.get_all("Item", filters={"name": ["in", names or [""]]}, fields=["name", "variant_of"])
	return {row.name: row.variant_of for row in rows}


def get_preview_doc(doc):
	values = doc.as_dict()
	for field in ("__onload", "item_details"):
		values.pop(field, None)
	invoice = doc.get("purchase_invoice") if doc.doctype == RECEIPT else None
	if invoice and frappe.has_permission(INVOICE, "read", doc=invoice):
		values["purchase_invoice_docstatus"] = frappe.db.get_value(INVOICE, invoice, "docstatus")
	return values


def get_connection_filters(doc):
	filters = {}
	if doc.doctype == PURCHASE_ORDER:
		filters = {RECEIPT: [["purchase_order", "=", doc.name]], CHALLAN: [["purchase_order", "=", doc.name]]}
	elif doc.doctype == RECEIPT:
		filters = receipt_connections(doc)
	elif doc.doctype == CHALLAN:
		filters = challan_connections(doc)
	elif doc.doctype == INVOICE:
		add_names(filters, RECEIPT, [row.get("goods_received_note") for row in doc.get("items") or []])
	elif doc.doctype == CLOSE:
		add_names(filters, CHALLAN, [doc.get("delivery_challan")])
		add_names(filters, RECEIPT, [row.get("goods_received_note") for row in doc.get("outputs") or []])
	return filters


def add_names(filters, doctype, names):
	names = sorted(set(filter(None, names)))
	if names:
		filters.setdefault(doctype, []).append(["name", "in", names])


def receipt_connections(doc):
	filters = {
		CHALLAN: [
			["goods_received_note", "=", doc.name],
			["MGK Delivery Challan Item", "goods_received_note", "=", doc.name],
		]
	}
	add_names(filters, PURCHASE_ORDER, [doc.get("purchase_order")])
	add_names(filters, CHALLAN, [row.get("delivery_challan") for row in doc.get("delivery_challans") or []])
	add_names(filters, INVOICE, [doc.get("purchase_invoice")])
	add_stock_connections(filters, doc)
	return filters


def challan_connections(doc):
	filters = {
		RECEIPT: [["MGK GRN Delivery Challan", "delivery_challan", "=", doc.name]],
		CHALLAN: [["return_against", "=", doc.name]],
	}
	add_names(filters, PURCHASE_ORDER, [doc.get("purchase_order")])
	add_names(filters, RECEIPT, [doc.get("goods_received_note")])
	add_names(filters, CLOSE, [doc.get("delivery_challan_close")])
	add_names(filters, PLAN, [doc.get("mgk_process_planning")])
	add_stock_connections(filters, doc)
	return filters


def add_stock_connections(filters, doc):
	meta = frappe.get_meta("YRP Stock Entry")
	links = [
		field.fieldname for field in meta.fields if field.fieldtype == "Link" and field.options == doc.doctype
	]
	conditions = []
	if meta.has_field("against_id") and meta.has_field("against"):
		conditions = [["against", "=", doc.doctype], "and", ["against_id", "=", doc.name]]
	for field in links:
		clause = [field, "=", doc.name]
		conditions = [conditions, "or", clause] if conditions else clause
	if conditions:
		filters[meta.name] = conditions


def get_connections(doc):
	connections, events = [], []
	for doctype, filters in get_connection_filters(doc).items():
		if not frappe.has_permission(doctype, "read"):
			continue
		rows = frappe.get_list(
			doctype,
			or_filters=filters,
			fields=["name", "creation"],
			distinct=True,
			order_by="creation desc",
			limit_page_length=0,
		)
		if not rows:
			continue
		connections.append({"doctype": doctype, "label": _(doctype), "names": [row.name for row in rows]})
		events.extend(
			{"at": cstr(row.creation), "text": _("{0} {1} created").format(_(doctype), row.name)}
			for row in rows
		)
	return connections, events


def get_timeline(doc, linked_events):
	versions, _next_start, _has_more = get_version_page(doc.meta, doc.name, 0, 20)
	events = [{"at": cstr(doc.creation), "text": _("Created")}]
	for version in versions:
		for event in version["events"]:
			if event in ("submitted", "cancelled"):
				events.append({"at": version["at"], "text": _(event.title())})
	return sorted(events + linked_events, key=lambda event: event["at"], reverse=True)[:20]


def get_extra(doc):
	if doc.doctype == CLOSE:
		return get_close_extra(doc)
	if doc.doctype != CHALLAN:
		return {}
	plan_name = doc.get("mgk_process_planning")
	if not plan_name or not frappe.has_permission(PLAN, "read", doc=plan_name):
		return {"plan_rows": []}
	plan = frappe.get_doc(PLAN, plan_name)
	plan.apply_fieldlevel_read_permissions()
	return {"plan_rows": add_item_attributes([row.as_dict() for row in plan.get("items") or []])}


def get_close_extra(doc):
	name = doc.get("delivery_challan")
	if not name or not frappe.has_permission(CHALLAN, "read", doc=name):
		return {}
	challan = frappe.get_doc(CHALLAN, name)
	challan.apply_fieldlevel_read_permissions()
	return {"process_name": challan.get("process_name")}
