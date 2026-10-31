import test from "node:test"
import assert from "node:assert/strict"
import { getMaster, masters } from "../src/masters/mastersConfig.js"
import { masterHeading, masterSections } from "../src/masters/masterFields.js"

const user = { name: "Administrator" }
const field = (fieldname, fieldtype = "Data", extra = {}) => ({ fieldname, label: fieldname, fieldtype, ...extra })
const names = (sections) => sections.map((section) => section.fields.map((field) => field.fieldname))
const metadata = (fields) => ({ name: "Test Master", fields })

test("Supplier has MCY identity, GSTIN and terms groups without ERPNext accounting, portal or customer tables", () => {
	const meta = metadata([
		field("supplier_name", "Data", { reqd: 1 }), field("supplier_type"), field("supplier_group"),
		field("accounts_section", "Section Break", { label: "Default Accounts" }), field("accounts", "Table"),
		field("taxes", "Section Break"), field("tax_id"), field("pan"),
		field("yrp_details", "Section Break"), field("uid"), field("disabled", "Check"), field("is_company_location", "Check"),
		field("department"), field("po_terms_and_condition"), field("wo_terms_and_condition"),
		field("portal_users", "Section Break"), field("portal_users_table", "Table"), field("customer_numbers", "Table"),
	])
	const sections = masterSections(getMaster("suppliers"), meta, {}, user)
	assert.deepEqual(sections.map((section) => section.label), ["Supplier identity", "Tax details", "Default terms"])
	assert.deepEqual(names(sections), [["supplier_name", "disabled", "is_company_location", "department"], ["tax_id", "pan"], ["po_terms_and_condition", "wo_terms_and_condition"]])
	assert.equal(sections[1].fields[0].label, "GSTIN")
	assert.equal(sections[0].fields[0].description, "Use the familiar supplier or job-worker name.")
	assert.equal(meta.fields.find((field) => field.fieldname === "tax_id").label, "tax_id")
	assert.equal(getMaster("suppliers").party, true)
})

test("Item uses three MCY groups with ERPNext identity/UOM and MGK tax and toggles", () => {
	const fields = ["stock_uom", "uoms", "purchase_uom", "item_name", "item_code", "mgk_is_salavai_cone", "mgk_is_karigan", "disabled", "item_group", "hsn_code", "mgk_gst_tax_slab", "brand", "is_stock_item", "is_purchase_item", "weight_per_unit", "weight_uom", "categories", "barcodes", "supplier_items", "yrp_categories", "valuation_method"]
	const meta = metadata(fields.map((name) => field(name, name.startsWith("mgk_is") ? "Check" : "Data")))
	const sections = masterSections(getMaster("items"), meta, {}, user)
	assert.deepEqual(sections.map((section) => section.label), ["Item identity", "Stock and purchasing", "Units and attributes"])
	assert.deepEqual(names(sections), [["item_code", "item_name", "item_group", "brand", "hsn_code", "mgk_gst_tax_slab", "disabled"], ["is_stock_item", "is_purchase_item", "mgk_is_karigan", "mgk_is_salavai_cone"], ["stock_uom", "purchase_uom", "uoms"]])
	assert.equal(sections[2].fields[0].label, "Primary UOM")
	assert.deepEqual(sections[1].fields[2].boolLabels, { on: "Karigan item", off: "Not a Karigan item" })
	assert.equal(sections[1].fields[2].description, "")
})

test("Warehouse keeps ERPNext identity and hierarchy while dropping unrelated fields and missing MCY names", () => {
	const meta = metadata([field("account"), field("warehouse_name", "Data", { reqd: 1 }), field("supplier", "Link"),
		field("disabled", "Check"), field("is_group", "Check"), field("parent_warehouse", "Link"), field("company", "Link"), field("warehouse_type")])
	const sections = masterSections(getMaster("warehouses"), meta, {}, user)
	assert.deepEqual(sections.map((section) => section.label), ["Warehouse identity"])
	assert.deepEqual(names(sections), [["warehouse_name", "supplier", "disabled", "is_group", "parent_warehouse", "company"]])
	assert.equal(sections[0].fields[1].label, "Linked supplier")
})

test("Item process conversions use the fixture visibility rule for templates only", async () => {
	const { readFile } = await import("node:fs/promises")
	const fixtures = JSON.parse(await readFile(new URL("../../mgk_yrp/fixtures/custom_field.json", import.meta.url)))
	const fields = fixtures.filter((field) => field.dt === "Item")
	const meta = { name: "Item", fields: [field("has_variants", "Check"), ...fields] }
	for (const has_variants of [0, 1]) {
		const sections = masterSections(getMaster("items"), meta, { has_variants }, user)
		assert.equal(sections.some((section) => section.label === "Process conversions"), Boolean(has_variants))
		assert.equal(sections.flatMap((section) => section.fields).some((field) => field.fieldname === "mgk_process_conversions"), Boolean(has_variants))
	}
})

test("Process shows only Process Name in the form and list", () => {
	const meta = metadata([field("process_name"), field("is_group", "Check"), field("is_item_conversion", "Check"), field("input_uom"), field("output_uom"),
		field("details", "Section Break"), field("process_details", "Table"), field("value_change_attributes", "Table"), field("unexpected")])
	const master = getMaster("processes")
	assert.deepEqual(master.columns, ["process_name"])
	for (const is_group of [0, 1]) {
		const sections = masterSections(master, meta, { is_group }, user)
		assert.deepEqual(names(sections), [["process_name"]])
		assert.equal(sections[0].fields[0].label, "Process Name")
	}
})

test("Agent and Received Type use MCY grouping, labels and help", () => {
	const agent = masterSections(getMaster("agents"), metadata([field("commission_terms"), field("agent_name"), field("disabled", "Check"), field("unexpected")]), {}, user)
	assert.deepEqual(agent.map((section) => section.label), ["Agent identity", "Commission reference"])
	assert.deepEqual(names(agent), [["agent_name", "disabled"], ["commission_terms"]])
	assert.match(agent[1].fields[0].description, /commission reference/)
	const received = masterSections(getMaster("received-types"), metadata([field("is_default", "Check"), field("received_type_name"), field("unexpected")]), {}, user)
	assert.deepEqual(names(received), [["received_type_name", "is_default"]])
	assert.equal(received[0].label, "Receipt classification")
	assert.equal(received[0].fields[1].label, "Use as default")
})

test("Address has exactly the requested fields and its Dynamic Link table, dropping optional GSTIN if missing", () => {
	const expected = ["address_title", "address_type", "address_line1", "address_line2", "city", "state", "pincode", "country", "phone", "email_id", "gstin", "is_primary_address", "is_shipping_address", "disabled", "links"]
	for (const hasGstin of [false, true]) {
		const available = expected.filter((name) => hasGstin || name !== "gstin")
		const meta = metadata([...available.toReversed().map((name) => field(name, name === "links" ? "Table" : "Data", name === "links" ? { options: "Dynamic Link" } : {})), field("tax_category"), field("county")])
		const sections = masterSections(getMaster("addresses"), meta, {}, user)
		assert.deepEqual(sections.flatMap((section) => section.fields.map((field) => field.fieldname)), available)
		assert.equal(sections.at(-1).fields[0].options, "Dynamic Link")
	}
})

test("grouping respects hidden ancestors, field conditions, permissions and explicit hiding", () => {
	const master = { formOrder: ["a", "b", "c", "d", "table", "secret", "e"], fields: ["a", "b", "c", "d", "table", "secret", "e"],
		formGroups: [{ label: "Visible", fields: ["a", "b", "c", "d", "table", "secret", "e"] }, { label: "Missing", fields: ["absent"] }], hideFormFields: ["d"], hideChildTables: ["table"] }
	const meta = { fields: [field("a"), field("b", "Data", { hidden: 1 }), field("c", "Data", { depends_on: "show" }), field("d"), field("table", "Table"), field("secret", "Data", { permlevel: 1 }),
		field("hidden_tab", "Tab Break", { hidden: 1 }), field("hidden_section", "Section Break"), field("e")], permissions: [{ role: "Stock User", read: 1 }] }
	assert.deepEqual(names(masterSections(master, meta, {}, { roles: ["Stock User"] })), [["a"]])
	assert.deepEqual(names(masterSections(master, meta, { show: 1 }, user)), [["a", "c", "secret"]])
})

test("hideFormFields and hideChildTables apply even to explicitly ordered fields", () => {
	const master = { fields: ["name", "weight", "categories"], formOrder: ["name", "weight", "categories"],
		formGroups: [{ label: "Identity", fields: ["name", "weight", "categories"] }], hideFormFields: ["weight"], hideChildTables: ["categories"] }
	assert.deepEqual(names(masterSections(master, metadata([field("name"), field("weight"), field("categories", "Table")]), {}, user)), [["name"]])
})

test("every master hero uses singular Master kicker, record title and description, with ID fallback", () => {
	for (const master of masters) {
		const doc = { name: "RECORD-001", [master.titleFields[0]]: "A familiar name" }
		assert.deepEqual(masterHeading(master, doc, {}, false), { kicker: `${master.entityLabel} Master`, title: "A familiar name", description: master.description })
		assert.equal(masterHeading(master, { ...doc, custom_title: "Metadata title" }, { title_field: "custom_title" }, false).title, "Metadata title")
		assert.equal(masterHeading(master, { name: "RECORD-001" }, {}, false).title, "RECORD-001")
		assert.equal(masterHeading(master, {}, {}, true).title, `Create a new ${master.entityLabel.toLowerCase()}`)
	}
})
