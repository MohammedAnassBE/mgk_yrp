import frappe
from frappe.model.document import Document
from frappe.utils import nowdate
from yrp.yrp.doctype.yrp_item.yrp_item import create_variant, ensure_global_attribute_values


def make_uom(name) -> str:
	if not frappe.db.exists("UOM", name):
		frappe.get_doc({"doctype": "UOM", "uom_name": name, "enabled": 1}).insert(ignore_permissions=True)
	return name


def get_company() -> str:
	company = frappe.db.get_single_value("MGK Settings", "company") or frappe.db.get_value(
		"Company", {}, "name"
	)
	if not company:
		frappe.throw("Create a Company before running MGK integration tests.")
	return company


def make_item_group() -> str:
	group = frappe.db.get_value("Item Group", {"is_group": 0}, "name")
	if group:
		return group
	name = f"MGK Test Group {frappe.generate_hash(length=8)}"
	return (
		frappe.get_doc(
			{
				"doctype": "Item Group",
				"item_group_name": name,
				"parent_item_group": "All Item Groups",
				"is_group": 0,
			}
		)
		.insert(ignore_permissions=True)
		.name
	)


def make_item(
	*,
	stock_uom,
	purchase_uom=None,
	conversion_factor=None,
	tax_slab=None,
	is_karigan=0,
	is_salavai_cone=0,
	excess_percent=0,
) -> str:
	name = f"MGK Test Item {frappe.generate_hash(length=8)}"
	conversions = [{"uom": make_uom(stock_uom), "conversion_factor": 1}]
	if purchase_uom and purchase_uom != stock_uom:
		conversions.append({"uom": make_uom(purchase_uom), "conversion_factor": conversion_factor})
	item = frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": name,
			"item_name": name,
			"item_group": make_item_group(),
			"stock_uom": stock_uom,
			"purchase_uom": purchase_uom,
			"uoms": conversions,
			"is_stock_item": 1,
			"is_purchase_item": 1,
			"is_sales_item": 0,
			"mgk_gst_tax_slab": tax_slab,
			"mgk_is_karigan": is_karigan,
			"mgk_is_salavai_cone": is_salavai_cone,
			"po_excess_allowed_percentage": excess_percent,
		}
	)
	if purchase_uom and purchase_uom != stock_uom:
		return make_item_with_purchase_uom(item, purchase_uom)
	return item.insert(ignore_permissions=True).name


def make_item_attribute():
	suffix = frappe.generate_hash(length=8)
	name, value = f"MGK Test Attribute {suffix}", f"Value {suffix}"
	frappe.get_doc({"doctype": "Item Attribute", "attribute_name": name}).insert(ignore_permissions=True)
	ensure_global_attribute_values(name, [value], check_permission=False)
	mapping = frappe.get_doc(
		{
			"doctype": "YRP Item Item Attribute Mapping",
			"attribute_name": name,
			"values": [{"attribute_value": value}],
		}
	).insert(ignore_permissions=True)
	return {"attribute": name, "mapping": mapping.name}, value


def make_item_with_purchase_uom(item, purchase_uom) -> str:
	primary, primary_value = make_item_attribute()
	dependent, dependent_value = make_item_attribute()
	item.has_variants = 1
	item.primary_attribute = primary["attribute"]
	item.secondary_unit_of_measure = item.stock_uom
	item.set("attributes", [primary, dependent])
	item.insert(ignore_permissions=True)
	item.dependent_attribute = dependent["attribute"]
	item.save(ignore_permissions=True)
	mapping = frappe.get_doc("YRP Item Dependent Attribute Mapping", item.dependent_attribute_mapping)
	for row in mapping.details:
		row.uom = purchase_uom
	mapping.save(ignore_permissions=True)
	frappe.clear_document_cache("Item", item.name)
	frappe.clear_document_cache("YRP Item Dependent Attribute Mapping", mapping.name)
	variant = create_variant(
		item.name,
		{
			primary["attribute"]: primary_value,
			dependent["attribute"]: dependent_value,
		},
	)
	return variant.insert(ignore_permissions=True).name


def make_supplier(*, tax_id=None, is_company_location=0) -> str:
	name = f"MGK Test Supplier {frappe.generate_hash(length=8)}"
	return (
		frappe.get_doc(
			{
				"doctype": "Supplier",
				"supplier_name": name,
				"supplier_type": "Company",
				"tax_id": tax_id,
				"is_company_location": is_company_location,
			}
		)
		.insert(ignore_permissions=True)
		.name
	)


def make_warehouse(*, supplier=None) -> str:
	name = f"MGK Test Warehouse {frappe.generate_hash(length=8)}"
	return (
		frappe.get_doc(
			{
				"doctype": "Warehouse",
				"warehouse_name": name,
				"company": get_company(),
				"supplier": supplier,
				"is_group": 0,
			}
		)
		.insert(ignore_permissions=True)
		.name
	)


def make_process() -> str:
	name = f"MGK Test Process {frappe.generate_hash(length=8)}"
	return (
		frappe.get_doc({"doctype": "YRP Process", "process_name": name}).insert(ignore_permissions=True).name
	)


def make_tax_slab(percentage: str, enabled=1) -> str:
	if not frappe.db.exists("YRP Tax Slab", percentage):
		frappe.get_doc({"doctype": "YRP Tax Slab", "percentage": percentage, "enabled": enabled}).insert(
			ignore_permissions=True
		)
	else:
		frappe.db.set_value("YRP Tax Slab", percentage, "enabled", enabled)
		frappe.clear_document_cache("YRP Tax Slab", percentage)
	return percentage


def set_mgk_settings(company_gstin="33AAAAA0000A1Z5") -> None:
	settings = frappe.get_single("MGK Settings")
	settings.company = get_company()
	settings.company_gstin = company_gstin
	settings.save(ignore_permissions=True)


def make_purchase_order(*, supplier, warehouse, items: list[dict], submit=True, **header) -> Document:
	order = frappe.get_doc(
		{
			"doctype": "MGK Purchase Order",
			"supplier": supplier,
			"warehouse": warehouse,
			"delivery_location": supplier,
			"po_date": nowdate(),
			"goods_routing": "Direct",
			"items": items,
			**header,
		}
	).insert(ignore_permissions=True)
	if submit:
		order.submit()
	return order


def make_po_grn(po, quantities: dict[str, float] | None = None, submit=True) -> Document:
	from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import make_goods_received_note

	receipt = make_goods_received_note(po.name)
	if quantities is not None:
		receipt.set("items", [row for row in receipt.items if row.purchase_order_item in quantities])
		for row in receipt.items:
			row.qty = quantities[row.purchase_order_item]
	receipt.insert(ignore_permissions=True)
	if submit:
		receipt.submit()
	return receipt


def make_job_work_grn(*, supplier, warehouse, items, delivery_challans=(), submit=True) -> Document:
	receipt = frappe.get_doc(
		{
			"doctype": "MGK Goods Received Note",
			"against_purchase_order": 0,
			"supplier": supplier,
			"warehouse": warehouse,
			"items": items,
			"delivery_challans": [{"delivery_challan": name} for name in delivery_challans],
		}
	).insert(ignore_permissions=True)
	if submit:
		receipt.submit()
	return receipt


def make_delivery_challan(
	*, from_warehouse, to_supplier, to_warehouse, items, process_name=None, submit=True, **header
) -> Document:
	challan = frappe.get_doc(
		{
			"doctype": "MGK Delivery Challan",
			"from_location": frappe.db.get_value("Warehouse", from_warehouse, "supplier"),
			"from_warehouse": from_warehouse,
			"to_location": to_supplier,
			"to_warehouse": to_warehouse,
			"process_name": process_name or make_process(),
			"items": items,
			**header,
		}
	).insert(ignore_permissions=True)
	if submit:
		challan.submit()
	return challan


def make_return(dc, quantities: dict[str, float], submit=True) -> Document:
	from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import make_return_delivery_challan

	challan = make_return_delivery_challan(dc.name)
	challan.set("items", [row for row in challan.items if row.against_dc_item in quantities])
	for row in challan.items:
		row.qty = quantities[row.against_dc_item]
	challan.insert(ignore_permissions=True)
	if submit:
		challan.submit()
	return challan


def close_dc(dc, submit=True) -> Document:
	from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import make_delivery_challan_close

	close = make_delivery_challan_close(dc.name).insert(ignore_permissions=True)
	if submit:
		close.submit()
	return close


def run_adjustments(source_doctype, source_name) -> list[str]:
	from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
		process_adjustment,
	)

	for _attempt in range(10):
		rows = frappe.get_all(
			"YRP Stock Valuation Adjustment",
			filters={
				"source_doctype": source_doctype,
				"source_name": source_name,
				"docstatus": 1,
			},
			fields=["name", "status"],
			order_by="creation, name",
		)
		if any("Failed" in row.status for row in rows):
			raise AssertionError(f"Valuation failed: {rows}")
		pending = [row for row in rows if row.status not in ("Completed", "Reversed")]
		if not pending:
			return [row.name for row in rows]
		for row in pending:
			process_adjustment(row.name)
	raise AssertionError(f"Valuation did not finish for {source_doctype} {source_name}")


def make_address(party_type, party_name) -> str:
	return (
		frappe.get_doc(
			{
				"doctype": "Address",
				"address_title": f"MGK Test Address {frappe.generate_hash(length=8)}",
				"address_type": "Billing",
				"address_line1": "MGK Test Street",
				"city": "Tiruppur",
				"country": "India",
				"is_primary_address": 1,
				"links": [{"link_doctype": party_type, "link_name": party_name}],
			}
		)
		.insert(ignore_permissions=True)
		.name
	)


def make_contact(party_type, party_name) -> str:
	return (
		frappe.get_doc(
			{
				"doctype": "Contact",
				"first_name": f"MGK Test Contact {frappe.generate_hash(length=8)}",
				"is_primary_contact": 1,
				"phone_nos": [{"phone": "9876543210", "is_primary_mobile_no": 1}],
				"links": [{"link_doctype": party_type, "link_name": party_name}],
			}
		)
		.insert(ignore_permissions=True)
		.name
	)
