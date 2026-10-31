export function routeFilters(doctype, query) {
	if (!["MGK Goods Received Note", "MGK Delivery Challan"].includes(doctype) || !query.purchase_order) return null
	return [["purchase_order", "=", String(query.purchase_order)], ["docstatus", "<", 2]]
}
