const definition = {
	type: "mgk-delivery-challan-close",
	key: "delivery-challan-close",
	doctype: "MGK Delivery Challan Close",
	label: "DC Close",
	code: "DCC",
	cover: "cover-dc",
	description: "Review delivered value and linked GRN outputs.",
	routePath: "/delivery-challan-close",
	listPath: "/delivery-challan-close",
	presentation: "book",
	allowCreate: false,
	tabs: [
		{ key: "all", label: "All", filters: [] },
		{ key: "reopened", label: "Reopened", filters: [["reopen_status", "=", "Reopened"]] },
	],
	defaultColumns: ["name", "delivery_challan", "supplier", "posting_date", "total_dc_value", "total_output_qty", "reopen_status"],
	statusField: "reopen_status",
	columnLabels: { delivery_challan: "DC", total_dc_value: "DC Value", total_output_qty: "Output Qty" },
	relatedDoctypes: ["MGK Delivery Challan", "MGK Goods Received Note"],
}

export default definition
