const definition = {
	type: "mgk-purchase-order",
	key: "purchase-order",
	doctype: "MGK Purchase Order",
	label: "Purchase Order",
	code: "PO",
	cover: "cover-po",
	description: "Plan purchases, quantities and deliveries.",
	routePath: "/purchase-order",
	presentation: "book",
	tabs: [
		{ key: "all", label: "All", filters: [] },
		{ key: "karigan", label: "Karigan", filters: [["item_group", "=", "Karigan Items"]] },
		{ key: "salavai-cone", label: "Salavai Cone", filters: [["item_group", "=", "Salavai Cone Items"]] },
	],
	defaultColumns: ["name", "supplier", "po_date", "delivery_location", "total_qty", "total_amount", "status"],
	statusField: "status",
	columnLabels: { total_qty: "Total Qty" },
	relatedDoctypes: ["MGK Goods Received Note", "MGK Delivery Challan"],
}

export default definition
