import json

import frappe
from frappe.utils import flt


@frappe.whitelist()
def get_last_purchase_rates(item_details, supplier=None, current_purchase_order=None):
	"""Latest positive rate per editor cell from the supplier's submitted, readable MGK Purchase Orders."""
	if isinstance(item_details, str):
		item_details = json.loads(item_details or "[]")
	if not supplier or not isinstance(item_details, list):
		return {}
	variant_by_key = resolve_last_rate_variants(item_details)
	if not variant_by_key:
		return {}
	filters = {"supplier": supplier, "docstatus": 1}
	if current_purchase_order:
		filters["name"] = ["!=", current_purchase_order]
	orders = frappe.get_list(
		"MGK Purchase Order",
		filters=filters,
		fields=["name", "po_date", "creation"],
		order_by="po_date desc, creation desc",
		limit_page_length=0,
	)
	if not orders:
		return {}
	latest_by_variant = get_latest_rates(orders, set(variant_by_key.values()))
	return {key: latest_by_variant[variant] for key, variant in variant_by_key.items() if variant in latest_by_variant}


def get_latest_rates(orders, variants):
	"""First positive rate per variant, following the given order ranking."""
	order_rank = {row.name: index for index, row in enumerate(orders)}
	order_dates = {row.name: row.po_date for row in orders}
	rows = frappe.get_all(
		"MGK Purchase Order Item",
		filters={"parenttype": "MGK Purchase Order", "parent": ["in", list(order_rank)], "item": ["in", sorted(variants)], "rate": [">", 0]},
		fields=["parent", "item", "rate", "idx"],
		limit_page_length=0,
	)
	rows.sort(key=lambda row: (order_rank[row.parent], row.idx or 0))
	latest = {}
	for row in rows:
		latest.setdefault(row.item, {"rate": flt(row.rate), "purchase_order": row.parent, "po_date": order_dates[row.parent]})
	return latest


def resolve_last_rate_variants(item_details):
	"""Map `group:item:value` editor keys to existing variants without creating any."""
	from yrp.yrp.doctype.yrp_item.yrp_item import get_variant

	variant_by_key = {}
	for group_index, group in enumerate(item_details):
		primary_attribute = group.get("primary_attribute")
		for item_index, item in enumerate(group.get("items") or []):
			if not item.get("name"):
				continue
			base = {key: value for key, value in (item.get("attributes") or {}).items() if value}
			for value_key, value in (item.get("values") or {}).items():
				if value is None:
					continue
				attributes = dict(base)
				if primary_attribute and value_key != "default":
					attributes[primary_attribute] = value_key
				variant = get_variant(item["name"], attributes)
				if variant:
					variant_by_key[f"{group_index}:{item_index}:{value_key}"] = variant
	return variant_by_key
