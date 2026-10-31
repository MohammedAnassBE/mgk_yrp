const itemGroups = [
	{ label: "Item identity", fields: ["item_name", "name1", "mgk_tamil_name", "item_group", "hsn_code", "gst_hsn_code", "mgk_gst_tax_slab", "is_purchase_item"] },
	{ label: "Stock and purchasing", fields: ["over_delivery_receipt_allowance", "po_excess_allowed_percentage", "is_ineligible_for_itc", "is_yarn_item"] },
	{ label: "Units and attributes", fields: ["stock_uom", "default_unit_of_measure", "secondary_unit_of_measure", "purchase_uom", "attributes", "primary_attribute", "dependent_attribute", "uoms"] },
	{ label: "Process conversions", fields: ["mgk_process_conversions"] },
]

export const stockItemFields = itemGroups.flatMap((group) => group.fields)
export const hiddenItemFields = ["item_code", "is_stock_item", "allow_negative_stock", "disabled", "is_sales_item", "has_variants"]

const definitions = [
	{
		key: "items", doctype: "Item", entityLabel: "Item", titleFields: ["item_name", "name1"], label: "Items", code: "ITM",
		description: "Yarn, fabric and other stock items.", columns: ["item_name", "stock_uom", "hsn_code"],
		formOrder: stockItemFields, formGroups: itemGroups, defaults: { item_group: "Products", is_stock_item: 1, disabled: 0, has_variants: 0 },
		fieldOverrides: { item_name: { reqd: 1 }, attributes: { hidden: 0, depends_on: "" } },
		baseFilters: [["variant_of", "is", "not set"]], baseOrFilters: [["has_variants", "=", 1], ["disabled", "=", 0]],
		hiddenSections: ["accounting", "accounting_tab", "sales_details", "sales", "sales_tab", "website", "website_tab", "deferred_accounting_section", "customer_details"],
		hideFormFields: ["weight_per_unit", "weight_uom"], hideChildTables: ["categories"], childColumns: { attributes: ["attribute"], uoms: ["uom", "conversion_factor"],
			mgk_process_conversions: ["process_name", "item", "from_uom", "from_qty", "to_uom", "to_qty"] },
		boolLabels: {
			is_yarn_item: { on: "Yarn item", off: "Not a yarn item" },
		},
		labels: { item_name: "Item name", name1: "Item name", mgk_tamil_name: "Item name (Tamil)",
			stock_uom: "Primary UOM", default_unit_of_measure: "Primary UOM", secondary_unit_of_measure: "Secondary UOM",
			over_delivery_receipt_allowance: "Delivery tolerance (%)", po_excess_allowed_percentage: "PO receipt excess (%)" },
		help: {
			mgk_tamil_name: "Enter the Tamil name shown throughout purchasing, production and stock screens.",
			stock_uom: "The unit used for normal purchasing and stock movement.",
			default_unit_of_measure: "The unit used for normal purchasing and stock movement.",
			primary_attribute: "The main variant dimension, such as Size or Colour.",
			attributes: "Add attributes such as Colour to make this Item a template with variants.", po_excess_allowed_percentage: "",
		},
	},
	{
		key: "processes", doctype: "YRP Process", entityLabel: "Process", titleFields: ["process_name"], label: "Processes", code: "PRC",
		description: "Production and job work stages.", columns: ["process_name"],
		formOrder: ["process_name"],
		formGroups: [{ label: "Process identity", fields: ["process_name"] }],
		labels: { process_name: "Process Name" },
	},
	{
		key: "received-types", doctype: "YRP Received Type", entityLabel: "Received Type", titleFields: ["received_type_name"], label: "Received Types", code: "RT",
		description: "Stock receipt classifications.", columns: ["received_type_name", "is_default", "modified"],
		formOrder: ["received_type_name", "is_default"],
		formGroups: [{ label: "Receipt classification", fields: ["received_type_name", "is_default"] }],
		labels: { received_type_name: "Received Type name", is_default: "Use as default" },
		help: { received_type_name: "The classification shown while receiving or inspecting stock.", is_default: "Use this classification automatically when no other Received Type is selected." },
	},
	{
		key: "warehouses", doctype: "Warehouse", entityLabel: "Warehouse", titleFields: ["warehouse_name", "name1"], label: "Warehouses", code: "WH",
		description: "Company stores and supplier warehouses.", party: true, columns: ["warehouse_name", "supplier", "is_group", "parent_warehouse", "disabled"],
		formOrder: ["warehouse_name", "name1", "mgk_tamil_name", "supplier", "disabled", "is_group", "parent_warehouse", "company"],
		formGroups: [{ label: "Warehouse identity", fields: ["warehouse_name", "name1", "mgk_tamil_name", "supplier", "disabled", "is_group", "parent_warehouse", "company"] }],
		labels: { warehouse_name: "Warehouse name", name1: "Warehouse name", mgk_tamil_name: "Warehouse name (Tamil)", supplier: "Linked supplier" },
		help: { mgk_tamil_name: "Enter the Tamil name shown in warehouse Link fields and movement views.", supplier: "Select the supplier associated with this warehouse." },
	},
	{
		key: "agents", doctype: "MGK Agent", entityLabel: "Agent", titleFields: ["agent_name"], label: "MGK Agents", code: "AGT",
		description: "Agents and their commission reference.", party: true, columns: ["agent_name", "commission_terms", "disabled"],
		formOrder: ["agent_name", "mgk_tamil_name", "disabled", "commission_terms"],
		formGroups: [
			{ label: "Agent identity", fields: ["agent_name", "mgk_tamil_name", "disabled"] },
			{ label: "Commission reference", fields: ["commission_terms"] },
		],
		help: { mgk_tamil_name: "Enter the Tamil agent name shown when Tamil display is enabled.", commission_terms: "Record the agreed informal commission reference for this agent." },
	},
	{
		key: "suppliers", doctype: "Supplier", entityLabel: "Supplier", titleFields: ["supplier_name"], label: "Suppliers", code: "SUP",
		description: "Suppliers with linked addresses and contacts.", party: true,
		columns: ["supplier_name", "supplier_primary_address", "tax_id", "mobile_no", "mgk_is_head_office", "disabled"], columnLabels: { tax_id: "GSTIN", supplier_primary_address: "Primary Address", mgk_is_head_office: "Head Office" },
		formOrder: ["supplier_name", "mgk_tamil_name", "disabled", "is_company_location", "mgk_is_head_office", "department", "tax_id", "gstin", "pan", "po_terms_and_condition", "wo_terms_and_condition"],
		formGroups: [
			{ label: "Supplier identity", fields: ["supplier_name", "mgk_tamil_name", "disabled", "is_company_location", "mgk_is_head_office", "department"] },
			{ label: "Tax details", fields: ["tax_id", "gstin", "pan"] },
			{ label: "Default terms", fields: ["po_terms_and_condition", "wo_terms_and_condition"] },
		],
		hideFormFields: ["uid"],
		boolLabels: { mgk_is_head_office: { on: "Head Office", off: "Not the Head Office" } },
		labels: { mgk_tamil_name: "Supplier name (Tamil)", tax_id: "GSTIN", gstin: "GSTIN / UIN", po_terms_and_condition: "Purchase Order terms", wo_terms_and_condition: "Work Order terms" },
		help: { supplier_name: "Use the familiar supplier or job-worker name.", mgk_tamil_name: "Enter the Tamil name exactly as operators should see it when Tamil is enabled.", is_company_location: "Enable only when this party represents an MGK-owned location." },
	},
	{
		key: "addresses", doctype: "Address", entityLabel: "Address", titleFields: ["address_title"], label: "Addresses", code: "ADR",
		description: "Party addresses and their document links.", columns: ["address_title", "address_type", "city", "links"], relatedDoctypes: ["Dynamic Link"],
		formOrder: ["address_title", "address_type", "address_line1", "address_line2", "city", "state", "pincode", "country", "phone", "email_id", "gstin", "is_primary_address", "is_shipping_address", "disabled", "links"],
		formGroups: [
			{ label: "Address identity", fields: ["address_title", "address_type", "address_line1", "address_line2", "city", "state", "pincode", "country"] },
			{ label: "Contact and defaults", fields: ["phone", "email_id", "gstin", "is_primary_address", "is_shipping_address", "disabled"] },
			{ label: "Linked parties", fields: ["links"] },
		],
	},
]

export function masterDefinition(definition) {
	const statusField = definition.columns.includes("disabled") ? "disabled" : definition.columns.includes("enabled") ? "enabled" : "__master_status"
	return { permission: "read", cover: "cover-masters", statusField, fields: definition.formOrder, ...definition,
		route: `/manage/${definition.key}`, routePath: `/manage/${definition.key}`, defaultColumns: definition.columns }
}

export const masters = definitions.map(masterDefinition)
export const contactMaster = masterDefinition({ key: "contacts", doctype: "Contact", entityLabel: "Contact", titleFields: ["full_name", "first_name"], label: "Contacts", code: "CON",
	description: "Party contacts and their document links.", columns: ["full_name", "email_id", "mobile_no", "links"] })

export function getMaster(key) { return [...masters, contactMaster].find((master) => master.key === key) }

export function isSystemManager(user = globalThis.window?.frappe?.boot?.user || {}) {
	return user.name === "Administrator" || (user.roles || globalThis.window?.frappe?.boot?.roles || []).includes("System Manager")
}

export function canEditMaster(master, user) { return !master.adminEditOnly || isSystemManager(user) }
