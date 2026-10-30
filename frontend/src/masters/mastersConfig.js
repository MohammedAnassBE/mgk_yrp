const itemGroups = [
	{ label: "Item identity", fields: ["item_code", "item_name", "name1", "mgk_tamil_name", "item_group", "brand", "hsn_code", "gst_hsn_code", "mgk_gst_tax_slab", "disabled"] },
	{ label: "Stock and purchasing", fields: ["is_stock_item", "allow_negative_stock", "is_purchase_item", "is_sales_item", "over_delivery_receipt_allowance", "po_excess_allowed_percentage", "is_ineligible_for_itc", "is_yarn_item", "mgk_is_karigan", "mgk_is_salavai_cone"] },
	{ label: "Units and attributes", fields: ["stock_uom", "default_unit_of_measure", "secondary_unit_of_measure", "purchase_uom", "primary_attribute", "dependent_attribute", "uoms"] },
]

export const stockItemFields = itemGroups.flatMap((group) => group.fields)

const definitions = [
	{
		key: "items", doctype: "Item", entityLabel: "Item", titleFields: ["item_name", "name1"], label: "Items", code: "ITM",
		description: "Yarn, fabric and other stock items.", columns: ["item_name", "item_group", "stock_uom", "hsn_code", "disabled"],
		formOrder: stockItemFields, formGroups: itemGroups,
		hiddenSections: ["accounting", "accounting_tab", "sales_details", "sales", "sales_tab", "website", "website_tab", "deferred_accounting_section", "customer_details"],
		hideFormFields: ["weight_per_unit", "weight_uom"], hideChildTables: ["categories"],
		boolLabels: {
			is_yarn_item: { on: "Yarn item", off: "Not a yarn item" },
			mgk_is_karigan: { on: "Karigan item", off: "Not a Karigan item" },
			mgk_is_salavai_cone: { on: "Salavai Cone item", off: "Not a Salavai Cone item" },
		},
		labels: { item_name: "Item name", name1: "Item name", mgk_tamil_name: "Item name (Tamil)",
			stock_uom: "Primary UOM", default_unit_of_measure: "Primary UOM", secondary_unit_of_measure: "Secondary UOM",
			over_delivery_receipt_allowance: "Delivery tolerance (%)", po_excess_allowed_percentage: "PO receipt excess (%)" },
		help: {
			mgk_tamil_name: "Enter the Tamil name shown throughout purchasing, production and stock screens.",
			item_group: "Choose the group that controls this Item's working behaviour.",
			stock_uom: "The unit used for normal purchasing and stock movement.",
			default_unit_of_measure: "The unit used for normal purchasing and stock movement.",
			primary_attribute: "The main variant dimension, such as Size or Colour.",
			allow_negative_stock: "", po_excess_allowed_percentage: "", mgk_is_karigan: "", mgk_is_salavai_cone: "",
		},
	},
	{
		key: "processes", doctype: "YRP Process", entityLabel: "Process", titleFields: ["process_name"], label: "Processes", code: "PRC",
		description: "Production and job work stages and defaults.", columns: ["process_name", "input_uom", "output_uom", "is_group", "is_item_conversion"],
		formOrder: ["process_name", "is_yarn_process", "is_item_conversion", "is_group", "is_manual_entry_in_grn", "input_uom", "output_uom", "default_wastage", "default_excess", "default_lead_time_days", "wo_excess_allowed_percentage", "value_change_attributes", "process_details"],
		formGroups: [
			{ label: "Process identity", fields: ["process_name", "is_yarn_process", "is_item_conversion", "is_group", "is_manual_entry_in_grn"] },
			{ label: "Units and defaults", fields: ["input_uom", "output_uom", "default_wastage", "default_excess", "default_lead_time_days", "wo_excess_allowed_percentage"] },
			{ label: "Transformation", fields: ["value_change_attributes"] },
			{ label: "Sub-processes", fields: ["process_details"] },
		],
		labels: { is_yarn_process: "Yarn process", is_item_conversion: "Changes the Item", is_manual_entry_in_grn: "Allow manual GRN entry", wo_excess_allowed_percentage: "Work Order receipt excess allowed %" },
		help: {
			is_yarn_process: "Enable when this Process participates in the MGK yarn production route.",
			is_item_conversion: "Enable when the input Item becomes a different output Item.",
			value_change_attributes: "Choose attributes such as Colour whose values this Process may change.",
			wo_excess_allowed_percentage: "Maximum extra quantity allowed when receiving against a Work Order.",
		},
	},
	{
		key: "users", doctype: "User", entityLabel: "User", titleFields: ["full_name", "first_name", "email"], label: "Users & Access", code: "USR",
		description: "Users, enabled state and roles.", adminEditOnly: true,
		columns: ["full_name", "email", "mobile_no", "last_active", "enabled"],
		formOrder: ["enabled", "email", "first_name", "middle_name", "last_name", "username", "user_type", "send_welcome_email", "language", "time_zone", "module_profile", "mobile_no", "phone", "location", "gender", "birth_date"],
		formGroups: [
			{ label: "User identity", fields: ["enabled", "email", "first_name", "middle_name", "last_name", "username", "user_type", "send_welcome_email"] },
			{ label: "Access defaults", fields: ["language", "time_zone", "module_profile"] },
			{ label: "Contact details", fields: ["mobile_no", "phone", "location", "gender", "birth_date"] },
		],
		hideChildTables: ["user_emails", "social_logins", "active_sessions", "roles", "role_profiles", "block_modules", "defaults"],
		defaults: { send_welcome_email: 0 }, fieldOverrides: { enabled: { read_only: 0 } },
		help: { email: "This becomes the User ID used to sign in.", send_welcome_email: "Send the new user a link to set their password.", module_profile: "Optionally limit which Desk modules this user can open." },
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
		description: "Company stores and supplier warehouses.", columns: ["warehouse_name", "supplier", "is_group", "parent_warehouse", "disabled"],
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
		columns: ["supplier_name", "supplier_primary_address", "tax_id", "mobile_no", "disabled"], columnLabels: { tax_id: "GSTIN", supplier_primary_address: "Primary Address" },
		formOrder: ["supplier_name", "mgk_tamil_name", "disabled", "is_company_location", "department", "tax_id", "gstin", "pan", "po_terms_and_condition", "wo_terms_and_condition"],
		formGroups: [
			{ label: "Supplier identity", fields: ["supplier_name", "mgk_tamil_name", "disabled", "is_company_location", "department"] },
			{ label: "Tax details", fields: ["tax_id", "gstin", "pan"] },
			{ label: "Default terms", fields: ["po_terms_and_condition", "wo_terms_and_condition"] },
		],
		hideFormFields: ["uid"],
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
