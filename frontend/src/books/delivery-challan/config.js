import { createGrnFromSelection } from "../../documents/shared/jobWork.js"

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
	bulkActions: [{ key: "create-grn", label: "Create GRN", permission: ["MGK Goods Received Note", "create"], run: createGrnFromSelection }],
	tabs: [
		{ key: "all", label: "All", filters: [] },
		{ key: "open", label: "Open", filters: [["docstatus", "=", 1], ["is_return", "=", 0], ["close_status", "=", "Open"], ["is_internal_transfer", "=", 0]] },
		{ key: "in-transit", label: "In Transit", filters: [["is_internal_transfer", "=", 1], ["transfer_status", "in", ["In Transit", "Partly Transferred"]]] },
		{ key: "closed", label: "Closed", filters: [["close_status", "=", "Closed"]] },
		{ key: "returns", label: "Returns", filters: [["is_return", "=", 1]] },
	],
	defaultColumns: ["name", "from_location", "to_location", "process_name", "posting_date", "total_qty", "close_status"],
	statusField: "close_status",
	columnLabels: { from_location: "From", to_location: "To", total_qty: "Total Qty" },
	relatedDoctypes: ["MGK Goods Received Note", "MGK Delivery Challan Close"],
}

export default definition
