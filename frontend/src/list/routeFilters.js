export function routeFilters(doctype, query) {
	if (doctype !== "MGK Goods Received Note" || !query.purchase_order) return null
	return [["purchase_order", "=", String(query.purchase_order)], ["docstatus", "<", 2]]
}
