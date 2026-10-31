const definition = {
	type: "mgk-supplier-credit-debit",
	key: "supplier-credit-debit",
	doctype: "MGK Supplier Credit Debit",
	label: "Credits & Debits",
	code: "CD",
	cover: "cover-credit",
	description: "Record supplier credits and debits.",
	routePath: "/supplier-credit-debit",
	presentation: "book",
	queryDefaults: ["entry_type"],
	tabs: [
		{ key: "all", label: "All", filters: [] },
		{ key: "credit", label: "Credit", filters: [["entry_type", "=", "Credit"]] },
		{ key: "debit", label: "Debit", filters: [["entry_type", "=", "Debit"]] },
	],
	defaultColumns: ["name", "supplier", "posting_date", "entry_type", "amount", "reason"],
	statusField: "entry_type",
	statusLabel: "Type",
	columnLabels: { posting_date: "Date", entry_type: "Type" },
	relatedDoctypes: [],
}

export default definition
