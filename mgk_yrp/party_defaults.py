import frappe
from yrp.party_addresses import get_party_address


@frappe.whitelist()
def get_party_defaults(supplier):
	if not supplier:
		frappe.throw(frappe._("Supplier is required."))
	frappe.get_doc("Supplier", supplier).check_permission("read")
	warehouses = get_warehouse_candidates(supplier)
	addresses = linked_candidates(
		"Address", supplier, ["address_type", "is_primary_address", "is_shipping_address"], {"disabled": 0}
	)
	contacts = linked_candidates("Contact", supplier, ["is_primary_contact"])
	address = get_party_address(supplier) if addresses else None
	address_names = [row.name for row in addresses]
	return {
		"warehouses": [row.name for row in warehouses],
		"warehouse": warehouses[0].name if len(warehouses) == 1 else None,
		"addresses": address_names,
		"address": address if address in address_names else None,
		"contacts": [row.name for row in contacts],
		"contact": unique_or_primary(contacts, "is_primary_contact"),
	}


def get_warehouse_candidates(supplier, *, ignore_permissions=False):
	query = frappe.get_all if ignore_permissions else frappe.get_list
	return query(
		"Warehouse",
		filters={"supplier": supplier, "disabled": 0, "is_group": 0},
		fields=["name"],
		limit_page_length=0,
		order_by="name",
	)


def get_head_office():
	location = frappe.db.get_value("Supplier", {"mgk_is_head_office": 1}, "name")
	if not location:
		frappe.throw(frappe._("Set Is Head Office on the Head Office supplier first."))
	supplier = frappe.get_doc("Supplier", location)
	supplier.check_permission("read")
	if supplier.disabled:
		frappe.throw(frappe._("Head Office {0} is disabled.").format(location))
	warehouses = get_warehouse_candidates(location, ignore_permissions=True)
	if len(warehouses) != 1:
		frappe.throw(
			frappe._("Head Office {0} must have exactly one warehouse; found {1}.").format(
				location, len(warehouses)
			)
		)
	frappe.get_doc("Warehouse", warehouses[0].name).check_permission("read")
	return {"location": location, "warehouse": warehouses[0].name}


def linked_candidates(doctype, supplier, fields, filters=None):
	return frappe.get_list(
		doctype,
		filters=[
			["Dynamic Link", "link_doctype", "=", "Supplier"],
			["Dynamic Link", "link_name", "=", supplier],
			*[[doctype, key, "=", value] for key, value in (filters or {}).items()],
		],
		fields=["name", *fields],
		distinct=True,
		limit_page_length=0,
		order_by="name",
	)


def unique_or_primary(rows, primary_field):
	if len(rows) == 1:
		return rows[0].name
	primary = [row for row in rows if row.get(primary_field)]
	return primary[0].name if len(primary) == 1 else None


@frappe.whitelist()
def get_own_location():
	frappe.get_doc("MGK Settings").check_permission("read")
	location = frappe.db.get_single_value("MGK Settings", "default_location")
	if not location:
		return {"location": None, "warehouse": None, "warehouses": []}
	defaults = get_party_defaults(location)
	return {"location": location, "warehouse": defaults["warehouse"], "warehouses": defaults["warehouses"]}
