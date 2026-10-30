const definition = {
	type: "mgk-goods-received-note",
	key: "goods-received-note",
	doctype: "MGK Goods Received Note",
	label: "Goods Received Note",
	code: "GRN",
	cover: "cover-grn",
	description: "Record goods received from suppliers.",
	routePath: "/goods-received-note",
	presentation: "book",
	tabs: [
		{ key: "all", label: "All", filters: [] },
		{ key: "job-work", label: "Job Work", filters: [["against_purchase_order", "=", 0]] },
		{ key: "purchase-order", label: "Purchase Order", filters: [["against_purchase_order", "=", 1]] },
	],
	defaultColumns: ["name", "supplier", "posting_date", "purchase_order", "warehouse", "total_qty", "total_amount", "purchase_invoice"],
	statusField: "purchase_invoice",
	statusLabel: "Billing",
	columnLabels: { total_qty: "Total Qty" },
	relatedDoctypes: ["MGK Purchase Invoice"],
}

export default definition
