const definition = {
	type: "mgk-delivery-challan",
	key: "delivery-challan",
	doctype: "MGK Delivery Challan",
	label: "Delivery Challan",
	code: "DC",
	cover: "cover-dc",
	description: "Track materials sent out for processing.",
	routePath: "/delivery-challan",
	presentation: "book",
	tabs: [],
	defaultColumns: ["name", "from_location", "to_location", "process_name", "posting_date", "total_qty", "close_status"],
	statusField: "close_status",
	columnLabels: { from_location: "From", to_location: "To", total_qty: "Total Qty" },
	relatedDoctypes: ["MGK Goods Received Note", "MGK Delivery Challan Close"],
}

export default definition
