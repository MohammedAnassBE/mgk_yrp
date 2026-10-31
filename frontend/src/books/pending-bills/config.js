const definition = {
	type: "mgk-pending-bills",
	key: "pending-bills",
	doctype: "MGK Goods Received Note",
	requiredDoctypes: ["MGK Purchase Invoice"],
	label: "Pending Bills",
	code: "PB",
	cover: "cover-pi",
	description: "Bill received goods, longest-waiting suppliers first.",
	routePath: "/pending-bills",
	presentation: "book",
	showCreate: false,
	countFilters: [["docstatus", "=", 1], ["purchase_invoice", "is", "not set"]],
	countLabel: "unbilled GRNs",
	openLabel: "Open bills",
	tabs: [],
	defaultColumns: [],
}

export default definition
