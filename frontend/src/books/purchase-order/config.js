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
		{ key: "karigan", label: "Karigan", filters: [["is_karigan_order", "=", 1]] },
		{ key: "salavai-cone", label: "Salavai Cone", filters: [["is_salavai_cone_order", "=", 1]] },
	],
	defaultColumns: ["name", "supplier", "po_date", "delivery_location", "total_qty", "total_amount", "status"],
	statusField: "status",
	columnLabels: { total_qty: "Total Qty" },
	relatedDoctypes: ["MGK Goods Received Note"],
}

export default definition
