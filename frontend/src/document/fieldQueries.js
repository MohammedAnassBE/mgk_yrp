import { purchaseOrderFilters } from "../documents/goods-received-note/fieldEvents.js"

export function fieldQuery(field, doc) {
	const name = field.fieldname
	if (doc.doctype === "Item" && name === "stock_uom") return { filters: { enabled: 1, secondary_only: 0 } }
	if (doc.doctype === "Item" && name === "item_group") return { filters: { is_group: 0 } }
	if (name === "mgk_gst_tax_slab") return { filters: { enabled: 1 } }
	if (name === "additional_parameter_value") return { filters: { key: doc.additional_parameter_key || "" } }
	if (field.options === "Supplier") return { filters: { disabled: 0 } }
	if (field.options === "Warehouse") {
		if (name === "parent_warehouse") return { filters: { is_group: 1, disabled: 0, ...(doc.company ? { company: doc.company } : {}) } }
		const source = { warehouse: "delivery_location", from_warehouse: "from_location", to_warehouse: "to_location" }[name]
		return { filters: { disabled: 0, is_group: 0, ...(doc[source] ? { supplier: doc[source] } : {}) } }
	}
	if (name === "supplier_address") return {
		query: "frappe.contacts.doctype.address.address.address_query",
		filters: { link_doctype: "Supplier", link_name: doc.supplier || "", disabled: 0 },
	}
	if (name === "contact_person") return {
		query: "frappe.contacts.doctype.contact.contact.contact_query",
		filters: { link_doctype: "Supplier", link_name: doc.supplier || "" },
	}
	if (name === "purchase_order") return { filters: purchaseOrderFilters(doc) }
	if (name === "delivery_challans") return { filters: { docstatus: 1, is_return: 0, close_status: "Open", to_location: doc.supplier || "" } }
	if (name === "delivery_challan") return { filters: { docstatus: 1, is_return: 0, close_status: "Open" } }
	return {}
}
