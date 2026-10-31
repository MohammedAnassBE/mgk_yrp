import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { derivedItemValues } from "../src/masters/itemConversions.js"
import { masters, getMaster, contactMaster, canEditMaster, stockItemFields, hiddenItemFields } from "../src/masters/mastersConfig.js"
import { childChange, dynamicTarget, dynamicLinkFields, masterSections, linkedPartyDraft, partyLinkFilters, safeReturnPath } from "../src/masters/masterFields.js"
import { fieldQuery } from "../src/document/fieldQueries.js"
import { listColumnMeta, columnDraft } from "../src/list/listColumns.js"
import { tableFields } from "../src/document/fields/tableFields.js"

test("Manage exposes exactly the eight requested masters with list, route and read gates", () => {
	assert.deepEqual(masters.map((master) => master.doctype), ["Item", "YRP Process", "YRP Received Type", "Warehouse", "MGK Agent", "Supplier", "Address"])
	for (const master of [...masters, contactMaster]) {
		assert.equal(master.route, `/manage/${master.key}`)
		assert.equal(master.permission, "read")
		assert.ok(master.columns.length > 0)
		assert.deepEqual(master.defaultColumns, master.columns)
		assert.equal(getMaster(master.key), master)
	}
	assert.equal(getMaster("prices"), undefined)
	assert.equal(getMaster("users"), undefined)
	const adminOnly = { adminEditOnly: true }
	assert.equal(canEditMaster(adminOnly, { roles: ["Stock User"] }), false)
	assert.equal(canEditMaster(adminOnly, { roles: ["System Manager"] }), true)
	assert.equal(canEditMaster(adminOnly, { name: "Administrator" }), true)
})

test("Dynamic Link Select changes its target and clears the old link name only when the DocType changes", () => {
	const fields = [{ fieldname: "link_doctype", fieldtype: "Link", options: "DocType" }, { fieldname: "link_name", fieldtype: "Dynamic Link", options: "link_doctype" }]
	const row = { link_doctype: "Supplier", link_name: "Vendor" }
	assert.equal(dynamicTarget(fields[1], row), "Supplier")
	assert.equal(dynamicTarget(fields[1], {}), "")
	assert.deepEqual(childChange(row, "link_doctype", "MGK Agent", fields), { link_doctype: "MGK Agent", link_name: null })
	assert.deepEqual(childChange(row, "link_doctype", "Supplier", fields), { link_doctype: "Supplier" })
	assert.deepEqual(childChange(row, "link_name", "Another", fields), { link_name: "Another" })
	const meta = dynamicLinkFields({ name: "Dynamic Link", fields }, ["MGK Agent", "Supplier"])
	assert.equal(meta.fields[0].fieldtype, "Select")
	assert.equal(meta.fields[0].options, "\nMGK Agent\nSupplier")
	assert.equal(fields[0].fieldtype, "Link")
})

test("Address and Contact drafts and list filters point at the real party, with internal return paths only", () => {
	for (const doctype of ["Supplier", "MGK Agent"]) {
		assert.deepEqual(linkedPartyDraft(doctype, "Parent / 1").links, [{ doctype: "Dynamic Link", link_doctype: doctype, link_name: "Parent / 1" }])
		assert.deepEqual(partyLinkFilters(doctype, "Parent / 1"), [["Dynamic Link", "link_doctype", "=", doctype], ["Dynamic Link", "link_name", "=", "Parent / 1"]])
	}
	assert.equal(safeReturnPath("/manage/agents/AG%2F1"), "/manage/agents/AG%2F1")
	for (const value of ["https://evil.test", "//evil.test", "/manage", ["/manage/users/a"]]) assert.equal(safeReturnPath(value), null)
})

test("meta sections preserve field order, ancestor visibility, allowlists and permlevels", () => {
	const field = (fieldname, fieldtype = "Data", extra = {}) => ({ fieldname, fieldtype, label: fieldname, ...extra })
	const meta = { fields: [field("first"), field("notes", "Section Break"), field("note"), field("column", "Column Break"),
		field("conditional", "Section Break", { depends_on: "show_extra" }), field("extra"),
		field("accounting", "Tab Break"), field("account"), field("stock", "Tab Break"), field("uoms", "Table"), field("hidden", "Data", { hidden: 1 })] }
	const master = { fields: ["first", "note", "extra", "uoms", "account"], hiddenSections: ["accounting"] }
	const sections = masterSections(master, meta, { show_extra: 0 }, { name: "Administrator" })
	assert.deepEqual(sections.map((section) => section.fields.map((field) => field.fieldname)), [["first"], ["note"], ["uoms"]])
	assert.equal(masterSections(master, meta, { show_extra: 1 }, { name: "Administrator" }).length, 4)
})

test("Item keeps ERPNext required fields, YRP stock fields and MGK GST while omitting accounting/sales/website", async () => {
	for (const name of ["item_name", "stock_uom", "purchase_uom", "uoms", "attributes", "secondary_unit_of_measure", "mgk_gst_tax_slab", "mgk_process_conversions"]) assert.ok(stockItemFields.includes(name), name)
	for (const name of hiddenItemFields) assert.equal(stockItemFields.includes(name), false, name)
	for (const name of ["item_defaults", "sales_uom", "website_image", "deferred_revenue_account"]) assert.equal(stockItemFields.includes(name), false)
	const config = getMaster("items")
	assert.ok(config.hiddenSections.includes("accounting"))
	const fixtures = JSON.parse(await readFile(new URL("../../mgk_yrp/fixtures/custom_field.json", import.meta.url)))
	for (const field of fixtures.filter((field) => field.dt === "Item" && field.fieldtype !== "Section Break")) assert.ok(stockItemFields.includes(field.fieldname) || hiddenItemFields.includes(field.fieldname), field.fieldname)
	assert.deepEqual(config.columns, ["item_name", "stock_uom", "hsn_code"])
	assert.deepEqual(config.defaults, { item_group: "Products", is_stock_item: 1, disabled: 0, has_variants: 0 })
	assert.deepEqual(config.fieldOverrides.attributes, { hidden: 0, depends_on: "" })
})

test("Item child tables show only the Desk columns; Variant Attributes is just the Item Attribute link", async () => {
	const childMeta = JSON.parse(await readFile(new URL("../../../erpnext/erpnext/stock/doctype/item_variant_attribute/item_variant_attribute.json", import.meta.url)))
	const itemMeta = { name: "Item", permissions: [], fields: [
		{ fieldname: "units_section", fieldtype: "Section Break", label: "Units" },
		{ fieldname: "attributes", fieldtype: "Table", label: "Variant Attributes", options: "Item Variant Attribute" }] }
	const [field] = masterSections({ ...getMaster("items"), formGroups: null }, itemMeta, {}, { name: "Administrator" })[0].fields
	const columns = tableFields({ ...childMeta, name: "Item Variant Attribute" }, field, { doctype: "Item", docstatus: 0 }, { ...childMeta, permissions: [] }, {}, { name: "Administrator" })
	assert.deepEqual(columns.map((column) => [column.fieldname, column.fieldtype, column.options]), [["attribute", "Link", "Item Attribute"]])
	assert.deepEqual(getMaster("items").childColumns, { attributes: ["attribute"], uoms: ["uom", "conversion_factor"],
		mgk_process_conversions: ["process_name", "item", "from_uom", "from_qty", "to_uom", "to_qty"] })
})

test("Item derives item_code from a new item name and has_variants from attribute rows", () => {
	assert.deepEqual(derivedItemValues("item_name", "Yarn 40's", true), { item_code: "Yarn 40's" })
	assert.deepEqual(derivedItemValues("item_name", "Renamed", false), {})
	assert.deepEqual(derivedItemValues("attributes", [{ attribute: "Colour" }], false), { has_variants: 1 })
	assert.deepEqual(derivedItemValues("attributes", [], false), { has_variants: 0 })
})

test("form checkbox width rule leaves the PrimeVue toggle input clickable", async () => {
	const css = await readFile(new URL("../src/document/fields/fields.css", import.meta.url), "utf8")
	assert.doesNotMatch(css, /\.form-field input\[type="checkbox"\]\s*\{/)
	assert.match(css, /\.form-field input\[type="checkbox"\]:not\(\.p-toggleswitch-input\)/)
})

test("Supplier Head Office follows Company Location in the form and has a list column and toggle labels", () => {
	const master = getMaster("suppliers")
	assert.equal(master.formOrder[master.formOrder.indexOf("is_company_location") + 1], "mgk_is_head_office")
	const identity = master.formGroups[0].fields
	assert.equal(identity[identity.indexOf("is_company_location") + 1], "mgk_is_head_office")
	assert.ok(master.defaultColumns.includes("mgk_is_head_office"))
	assert.equal(master.columnLabels.mgk_is_head_office, "Head Office")
	assert.deepEqual(master.boolLabels.mgk_is_head_office, { on: "Head Office", off: "Not the Head Office" })
})

test("Item master excludes variants and includes templates of any state or enabled plain items", () => {
	const master = getMaster("items")
	assert.deepEqual(master.baseFilters, [["variant_of", "is", "not set"]])
	assert.deepEqual(master.baseOrFilters, [["has_variants", "=", 1], ["disabled", "=", 0]])
})

test("master Link queries use enabled suppliers, Warehouse groups and YRP stock UOM and tax slab filters", () => {
	assert.deepEqual(fieldQuery({ fieldname: "supplier", options: "Supplier" }, { doctype: "Warehouse" }), { filters: { disabled: 0 } })
	assert.deepEqual(fieldQuery({ fieldname: "parent_warehouse", options: "Warehouse" }, { company: "MGK" }), { filters: { is_group: 1, disabled: 0, company: "MGK" } })
	assert.deepEqual(fieldQuery({ fieldname: "stock_uom" }, { doctype: "Item" }), { filters: { enabled: 1, secondary_only: 0 } })
	assert.deepEqual(fieldQuery({ fieldname: "mgk_gst_tax_slab" }, {}), { filters: { enabled: 1 } })
})

test("Process conversion Item link suggests only enabled templates and plain Items, including the edited Item", () => {
	const filters = { variant_of: ["is", "not set"], disabled: 0 }
	assert.deepEqual(fieldQuery({ fieldname: "item", options: "Item" }, { doctype: "MGK Item Process Conversion", parent: "Yarn 2-30's", parenttype: "Item" }), { filters })
	assert.deepEqual(fieldQuery({ fieldname: "item", options: "Item" }, { doctype: "MGK Item Process Conversion", __islocal: 1 }), { filters })
})

test("Address linked parties are a display-only selectable list column, and the original table meta stays intact", () => {
	const meta = { name: "Address", fields: [{ fieldname: "links", fieldtype: "Table", label: "Links", options: "Dynamic Link" }] }
	const columns = columnDraft(listColumnMeta(meta), ["links"], null, "__status")
	assert.equal(columns[0].enabled, true)
	assert.equal(columns[0].clientOnly, true)
	assert.equal(meta.fields[0].fieldtype, "Table")
})
