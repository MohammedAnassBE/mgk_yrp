import { formatDate } from "../../shared/formatDate.js"
import { displayName } from "../../shell/displayLanguage.js"
export function summary(doc, itemCount = doc.items?.length || 0) {
	const lines = [{ label: "Supplier", value: displayName("Supplier", doc.supplier) }, { label: "Delivery to", value: displayName("Supplier", doc.delivery_location) },
		{ label: "Routing", value: doc.goods_routing }, { label: "Items", value: itemCount },
		{ label: "Ordered quantity", value: doc.total_qty || 0 }]
	if (doc.name && !doc.__islocal) {
		lines.push({ label: "Received quantity", value: (doc.items || []).reduce((sum, row) => sum + Number(row.received_qty || 0), 0) },
			{ label: "Pending quantity", value: (doc.items || []).reduce((sum, row) => sum + Number(row.pending_qty || 0), 0) })
	}
	return { title: "Order summary", lines: [...lines, { label: "Order value", value: doc.total_amount || 0, money: true }],
		checklist: [
			{ label: "Check the supplier and PO date", complete: Boolean(doc.supplier && doc.po_date) },
			{ label: "Check delivery location, warehouse and routing", complete: Boolean(doc.delivery_location && doc.warehouse && doc.goods_routing && (doc.goods_routing !== "Through Vendor" || doc.handling_supplier)) },
			{ label: "Enter ordered quantities and rates", complete: itemCount > 0 && Number(doc.total_qty) > 0 && Number(doc.total_amount) > 0 },
		] }
}

export function viewFacts(doc) {
	return [["Supplier", displayName("Supplier", doc.supplier)], ["PO date", formatDate(doc.po_date)],
		["Delivery location", displayName("Supplier", doc.delivery_location)], ["Warehouse", displayName("Warehouse", doc.warehouse)],
		["Goods routing", doc.goods_routing], ["MGK Agent", displayName("MGK Agent", doc.mgk_agent)],
		["Handling supplier", displayName("Supplier", doc.handling_supplier)], ["Item group", displayName("Item Group", doc.item_group) || "Other"]].map(([label, value]) => ({ label, value }))
}

export function connections(doc) {
	return doc.name && !doc.__islocal ? [{ label: "Goods Received Notes", doctype: "MGK Goods Received Note",
		filters: [["purchase_order", "=", doc.name], ["docstatus", "<", 2]],
		to: { path: "/goods-received-note", query: { purchase_order: doc.name } } },
		{ label: "Delivery Challans", doctype: "MGK Delivery Challan",
			filters: [["purchase_order", "=", doc.name], ["docstatus", "<", 2]],
			to: { path: "/delivery-challan", query: { purchase_order: doc.name } } }] : []
}
