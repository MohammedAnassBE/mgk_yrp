from collections import defaultdict, deque
from copy import deepcopy

import frappe
from frappe.utils import flt
from yrp.stock.dimensions import get_dimension_fieldnames
from yrp.stock.save_stock_items import group_items_for_ui, ungroup_items_from_ui
from yrp.yrp.doctype.yrp_goods_received_note.yrp_goods_received_note import _po_excess_percentage

from mgk_yrp.stock.dimensions import get_dimension_defaults

COMMON_CONFIG = {
	"child_table_field": "items",
	"item_field": "item",
	"qty_field": "qty",
	"value_fields": ["rate", "uom", "stock_uom", "conversion_factor", "amount"],
	"entry_fields": ["table_index", "row_index"],
}
EDITOR_CONFIG = {
	"MGK Process Planning": {
		**COMMON_CONFIG,
		"child_doctype": "MGK Process Planning Item",
		"value_fields": ["uom", "stock_uom", "conversion_factor", "stock_qty"],
	},
	"MGK Purchase Order": {
		**COMMON_CONFIG,
		"child_doctype": "MGK Purchase Order Item",
		"value_fields": [*COMMON_CONFIG["value_fields"], "received_qty", "pending_qty"],
	},
	"MGK Delivery Challan": {
		**COMMON_CONFIG,
		"child_doctype": "MGK Delivery Challan Item",
		"value_fields": [
			*COMMON_CONFIG["value_fields"], "against_dc_item", "goods_received_note", "goods_received_note_item",
		],
	},
	"MGK Goods Received Note": {
		**COMMON_CONFIG,
		"child_doctype": "MGK Goods Received Note Item",
		"value_fields": [
			*COMMON_CONFIG["value_fields"], "purchase_order_item", "is_prefilled", "delivery_challan_item",
		],
	},
}


@frappe.whitelist()
def get_editor_context(purchase_order=None):
	context = {"defaults": get_dimension_defaults(), "po_entries": []}
	if purchase_order:
		order = frappe.get_doc("MGK Purchase Order", purchase_order)
		order.check_permission("read")
		groups = get_item_details(order)
		annotate_purchase_order_cells(frappe._dict(purchase_order=purchase_order), groups, order=order)
		context["po_entries"] = [entry for group in groups for entry in group["items"]]
		for cell in get_cells(groups):
			cell["purchase_order_item"] = cell.pop("name", None)
	return context


@frappe.whitelist()
def get_draft_item_details(doc):
	data = frappe.parse_json(doc)
	if data.get("doctype") not in EDITOR_CONFIG or data.get("docstatus") != 0:
		frappe.throw(frappe._("Item editor data requires a draft MGK document."))
	document = frappe.get_doc(data)
	frappe.has_permission(
		document.doctype, "create" if document.is_new() else "write", doc=document, throw=True
	)
	return get_item_details(document)


def get_item_details(doc):
	rows = [persisted_row_values(row) for row in doc.items]
	for index, row in enumerate(rows):
		if row.get("row_index") in (None, ""):
			row["row_index"] = f"__auto__{index}"
	config = EDITOR_CONFIG[doc.doctype]
	groups = group_items_for_ui(
		rows, doc.doctype, config={**config, "value_fields": [*config["value_fields"], "item"]}
	)
	attach_persisted_names(rows, groups)
	if doc.doctype == "MGK Goods Received Note" and doc.against_purchase_order:
		annotate_purchase_order_cells(doc, groups)
	return groups


def row_identity(row, dimensions):
	return (str(row["row_index"]), row["item"], *(row.get(field) or "" for field in dimensions))


def attach_persisted_names(rows, groups):
	"""Keep implicit row names outside YRP's child DocField filtering."""
	dimensions = get_dimension_fieldnames()
	names = defaultdict(deque)
	for row in rows:
		names[row_identity(row, dimensions)].append(row.get("name"))
	for group in groups:
		for entry in group["items"]:
			attach_entry_names(entry, names, dimensions)


def attach_entry_names(entry, names, dimensions):
	for cell in entry["values"].values():
		item = cell.pop("item", None)
		if not item:
			continue
		identity = {**entry.get("dimensions", {}), "row_index": entry["row_index"], "item": item}
		name = names[row_identity(identity, dimensions)].popleft()
		if name:
			cell["name"] = name


def persisted_row_values(row):
	values = dict(row if isinstance(row, dict) else row.as_dict())
	if values.get("__islocal") or (values.get("name") or "").startswith("new-"):
		values.pop("name", None)
	return values


def annotate_purchase_order_cells(doc, groups, order=None):
	order = order or frappe.get_doc("MGK Purchase Order", doc.purchase_order)
	order.check_permission("read")
	sources = {row.name: row for row in order.items}
	for cell in get_cells(groups):
		source = sources.get(cell.get("purchase_order_item") or cell.get("name"))
		if source:
			cell["pending_qty"] = flt(source.pending_qty)
			allowed = flt(source.qty) * (1 + _po_excess_percentage(source.item) / 100)
			cell["allowed_qty"] = max(0, allowed - flt(source.received_qty))


def get_cells(groups):
	return (cell for group in groups for entry in group["items"] for cell in entry["values"].values())


def editor_groups(doc):
	groups = deepcopy(frappe.parse_json(doc.item_details))
	link_field = get_source_field(doc)
	for group in groups:
		for entry in group["items"]:
			entry.pop("row_index", None)
			entry.pop("table_index", None)
			entry["values"] = {
				key: persisted_row_values(cell)
				for key, cell in entry["values"].items()
				if is_retained_cell(cell, link_field, doc)
			}
		group["items"] = [entry for entry in group["items"] if entry["values"]]
	return groups


def is_retained_cell(cell, link_field, doc=None):
	if doc and doc.doctype == "MGK Goods Received Note" and not doc.against_purchase_order:
		return bool(cell and (cell.get("is_prefilled") or cell.get("name") or flt(cell.get("qty"))))
	return bool(cell and (not link_field or cell.get(link_field) or flt(cell.get("qty"))))


def get_source_field(doc):
	if doc.doctype == "MGK Goods Received Note" and doc.against_purchase_order:
		return "purchase_order_item"
	if doc.doctype == "MGK Delivery Challan" and doc.is_return:
		return "against_dc_item"
	return None


def validate_persisted_names(doc, groups):
	names = [cell["name"] for cell in get_cells(groups) if cell.get("name")]
	if not names:
		return
	if len(names) != len(set(names)):
		frappe.throw(frappe._("Duplicate item editor row names are not allowed."))
	existing = set()
	if not doc.is_new():
		existing = set(
			frappe.get_all(
				EDITOR_CONFIG[doc.doctype]["child_doctype"],
				filters={"parent": doc.name, "parenttype": doc.doctype, "parentfield": "items"},
				pluck="name",
			)
		)
	for name in names:
		if name not in existing:
			frappe.throw(frappe._("Item editor row {0} does not belong to this document.").format(name))


def set_items_from_editor(doc):
	is_submitting = doc.docstatus == 1 and doc.get("_action") == "submit"
	if (doc.docstatus != 0 and not is_submitting) or not doc.get("item_details"):
		return
	keep_zero = doc.doctype == "MGK Goods Received Note" and (doc.against_purchase_order or doc.docstatus == 0)
	groups = editor_groups(doc)
	if doc.doctype == "MGK Goods Received Note":
		drop_unfilled_entries(groups)
	validate_persisted_names(doc, groups)
	rows = ungroup_items_from_ui(groups, doc.doctype, keep_zero=keep_zero, config=EDITOR_CONFIG[doc.doctype])
	cells = (cell for cell in get_cells(groups) if keep_zero or cell.get("qty"))
	for row, cell in zip(rows, cells, strict=True):
		if cell.get("name"):
			row["name"] = cell["name"]
	doc.set("items", rows)
	doc.item_details = None


def drop_unfilled_entries(groups):
	"""Drop zero-qty entries still missing attributes; a positive qty needs them filled."""
	for group in groups:
		optional = {group.get("primary_attribute"), group.get("dependent_attribute")}
		required = [attribute for attribute in group.get("attributes") or [] if attribute not in optional]
		kept = []
		for entry in group.get("items") or []:
			missing = [attribute for attribute in required if not (entry.get("attributes") or {}).get(attribute)]
			if missing and any(flt(cell.get("qty")) for cell in (entry.get("values") or {}).values()):
				frappe.throw(frappe._("Choose {0} for {1}.").format(", ".join(missing), entry.get("name")))
			if not missing:
				kept.append(entry)
		group["items"] = kept


def drop_zero_qty_rows(doc):
	if doc.docstatus == 1:
		doc.set("items", [row for row in doc.items if flt(row.qty) != 0])
		if not doc.items:
			frappe.throw(frappe._("Enter at least one item with a positive quantity."))
