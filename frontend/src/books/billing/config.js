const definition = {
	type: "mgk-billing",
	key: "billing",
	doctype: "MGK Purchase Invoice",
	label: "Billing",
	code: "PI",
	cover: "cover-pi",
	description: "Review supplier bills and received goods.",
	routePath: "/billing",
	presentation: "book",
	tabs: [
		{ key: "all", label: "All", filters: [] },
		{ key: "job-work", label: "Job Work", filters: [["against", "=", "Job Work"]] },
		{ key: "purchase-order", label: "Purchase Order", filters: [["against", "=", "Purchase Order"]] },
	],
	defaultColumns: ["name", "supplier", "against", "posting_date", "bill_no", "grand_total", "docstatus"],
	statusField: "docstatus",
	columnLabels: { bill_no: "Bill No" },
	relatedDoctypes: [],
}

export default definition
