const method = "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan"

export function actions(doc, can) {
	const result = []
	if (Number(doc.docstatus) === 1 && !doc.is_return && doc.close_status === "Open") {
		if (can("MGK Delivery Challan", "create")) result.push({ key: "return", label: "Return",
			method: `${method}.make_return_delivery_challan`, route: "/delivery-challan" })
		if (can("MGK Delivery Challan Close", "create")) result.push({ key: "close", label: "Close",
			method: `${method}.make_delivery_challan_close`, route: "/delivery-challan-close" })
	}
	if (doc.delivery_challan_close && can("MGK Delivery Challan Close", "read")) result.push({
		key: "view-close", label: "View Close", to: `/delivery-challan-close/${encodeURIComponent(doc.delivery_challan_close)}`,
	})
	return result
}
