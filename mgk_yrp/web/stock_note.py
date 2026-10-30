import json

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, nowdate

from mgk_yrp.web.stock_balance import run_stock_balance


def stock_filters(filters):
	if isinstance(filters, str):
		try:
			filters = json.loads(filters)
		except (ValueError, TypeError):
			frappe.throw(_("Stock filters must be a JSON object."))
	if not isinstance(filters, dict):
		frappe.throw(_("Stock filters must be an object."))
	for key in ("from_date", "to_date", "supplier", "warehouse", "item", "received_type"):
		if filters.get(key) is not None and not isinstance(filters[key], str):
			frappe.throw(_("Stock filter {0} must be text.").format(key))
	to_date = getdate(filters.get("to_date") or nowdate())
	from_date = getdate(filters.get("from_date") or add_days(to_date, -30))
	if from_date > to_date:
		frappe.throw(_("From Date cannot be after To Date."))
	return frappe._dict(filters, from_date=from_date, to_date=to_date)


def allowed_warehouses():
	filters = {"disabled": 0}
	if frappe.db.exists("DocType", "YRP Warehouse User"):
		restricted = frappe.get_all(
			"YRP Warehouse User", filters={"user": frappe.session.user, "parenttype": "Warehouse"},
			pluck="parent",
		)
		if restricted:
			filters["name"] = ["in", restricted]
	return frappe.get_list(
		"Warehouse", filters=filters, fields=["name", "warehouse_name", "supplier"],
		order_by="name asc", limit_page_length=0,
	)


def stock_options(warehouses):
	supplier_ids = sorted({row.supplier for row in warehouses if row.supplier})
	suppliers = frappe.get_list(
		"Supplier", filters={"name": ["in", supplier_ids], "disabled": 0},
		fields=["name", "supplier_name"], order_by="supplier_name asc, name asc", limit_page_length=0,
	) if supplier_ids else []
	title_fields = {}
	for doctype in ("Item", "Supplier", "Warehouse"):
		meta = frappe.get_meta(doctype)
		title_fields[doctype] = meta.title_field if cint(meta.show_title_field_in_link) == 1 else None
	return {
		"warehouses": warehouses, "suppliers": suppliers,
		"title_fields": title_fields,
		"items": frappe.get_list(
			"Item", filters={"disabled": 0, "is_stock_item": 1, "variant_of": ["is", "not set"]},
			fields=["name", "item_name", "stock_uom"], order_by="name asc", limit_page_length=0,
		),
		"received_types": frappe.get_list(
			"YRP Received Type", fields=["name"], order_by="name asc", limit_page_length=0,
		),
	}


def require_readable_filters(filters):
	for field, doctype in (("item", "Item"), ("supplier", "Supplier"), ("received_type", "YRP Received Type")):
		if filters.get(field) and not frappe.get_list(doctype, filters={"name": filters[field]}, pluck="name"):
			frappe.throw(_("You are not permitted to view this {0}.").format(doctype), frappe.PermissionError)


def readable_supplier_warehouses(warehouses):
	names = {row.supplier for row in warehouses if row.supplier}
	if not names:
		return warehouses
	allowed = set(frappe.get_list("Supplier", filters={"name": ["in", list(names)]}, pluck="name", limit_page_length=0))
	return [row for row in warehouses if not row.supplier or row.supplier in allowed]


def report_filters(filters, warehouses):
	allowed_names = {row.name for row in warehouses}
	if filters.warehouse and filters.warehouse not in allowed_names:
		frappe.throw(_("You are not permitted to view this Warehouse."), frappe.PermissionError)
	selected = [row.name for row in warehouses
		if (not filters.warehouse or row.name == filters.warehouse)
		and (not filters.supplier or row.supplier == filters.supplier)]
	return frappe._dict(
		from_date=filters.from_date, to_date=filters.to_date,
		warehouse=selected or ["__no_permitted_warehouse__"], parent_item=filters.item,
		received_type=filters.received_type, remove_zero_balance_item=1, show_inward_date_split=1,
	)


def stock_summary(rows):
	uom_totals = {}
	for row in rows:
		uom = row.stock_uom or "Units"
		uom_totals[uom] = flt(uom_totals.get(uom)) + flt(row.bal_qty)
	return {
		"line_count": len(rows), "warehouse_count": len({row.warehouse for row in rows}),
		"total_value": flt(sum(flt(row.bal_val) for row in rows), 2), "uom_totals": uom_totals,
	}


@frappe.whitelist()
def get_stock_note(filters=None):
	frappe.has_permission("YRP Stock Ledger Entry", ptype="read", throw=True)
	frappe.has_permission("Warehouse", ptype="read", throw=True)
	filters = stock_filters(filters if filters is not None else {})
	require_readable_filters(filters)
	warehouses = readable_supplier_warehouses(allowed_warehouses())
	_columns, data = run_stock_balance(report_filters(filters, warehouses))
	rows = [frappe._dict(row) for row in data]
	options = stock_options(warehouses)
	warehouse_map = {row.name: row for row in warehouses}
	supplier_map = {row.name: row.supplier_name for row in options["suppliers"]}
	for row in rows:
		warehouse = warehouse_map.get(row.warehouse, {})
		row.update(
			warehouse_name=warehouse.get("warehouse_name") or row.warehouse,
			supplier=warehouse.get("supplier"), supplier_name=supplier_map.get(warehouse.get("supplier")),
		)
	return {
		"filters": {"from_date": str(filters.from_date), "to_date": str(filters.to_date)},
		"options": options, "rows": rows, "summary": stock_summary(rows),
	}
