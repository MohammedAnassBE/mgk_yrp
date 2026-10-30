import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { masters, getMaster, contactMaster, canEditMaster, stockItemFields } from "../src/masters/mastersConfig.js"
import { childChange, dynamicTarget, dynamicLinkFields, masterSections, linkedPartyDraft, partyLinkFilters, safeReturnPath } from "../src/masters/masterFields.js"
import { fieldQuery } from "../src/document/fieldQueries.js"
import { listColumnMeta, columnDraft } from "../src/list/listColumns.js"

test("Manage exposes exactly the eight requested masters with list, route and read gates", () => {
	assert.deepEqual(masters.map((master) => master.doctype), ["Item", "YRP Process", "User", "YRP Received Type", "Warehouse", "MGK Agent", "Supplier", "Address"])
	for (const master of [...masters, contactMaster]) {
		assert.equal(master.route, `/manage/${master.key}`)
		assert.equal(master.permission, "read")
		assert.ok(master.columns.length > 0)
		assert.deepEqual(master.defaultColumns, master.columns)
		assert.equal(getMaster(master.key), master)
	}
	assert.equal(getMaster("prices"), undefined)
	assert.equal(canEditMaster(getMaster("users"), { roles: ["Stock User"] }), false)
	assert.equal(canEditMaster(getMaster("users"), { roles: ["System Manager"] }), true)
	assert.equal(canEditMaster(getMaster("users"), { name: "Administrator" }), true)
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
	for (const name of ["item_code", "item_name", "item_group", "stock_uom", "purchase_uom", "uoms", "secondary_unit_of_measure", "mgk_gst_tax_slab", "mgk_is_karigan", "mgk_is_salavai_cone"]) assert.ok(stockItemFields.includes(name), name)
	for (const name of ["item_defaults", "sales_uom", "website_image", "deferred_revenue_account"]) assert.equal(stockItemFields.includes(name), false)
	const config = getMaster("items")
	assert.ok(config.hiddenSections.includes("accounting"))
	const fixtures = JSON.parse(await readFile(new URL("../../mgk_yrp/fixtures/custom_field.json", import.meta.url)))
	for (const field of fixtures.filter((field) => field.dt === "Item")) assert.ok(stockItemFields.includes(field.fieldname))
})

test("master Link queries use enabled suppliers, Warehouse groups and YRP stock UOM and tax slab filters", () => {
	assert.deepEqual(fieldQuery({ fieldname: "supplier", options: "Supplier" }, { doctype: "Warehouse" }), { filters: { disabled: 0 } })
	assert.deepEqual(fieldQuery({ fieldname: "parent_warehouse", options: "Warehouse" }, { company: "MGK" }), { filters: { is_group: 1, disabled: 0, company: "MGK" } })
	assert.deepEqual(fieldQuery({ fieldname: "stock_uom" }, { doctype: "Item" }), { filters: { enabled: 1, secondary_only: 0 } })
	assert.deepEqual(fieldQuery({ fieldname: "mgk_gst_tax_slab" }, {}), { filters: { enabled: 1 } })
})

test("Address linked parties are a display-only selectable list column, and the original table meta stays intact", () => {
	const meta = { name: "Address", fields: [{ fieldname: "links", fieldtype: "Table", label: "Links", options: "Dynamic Link" }] }
	const columns = columnDraft(listColumnMeta(meta), ["links"], null, "__status")
	assert.equal(columns[0].enabled, true)
	assert.equal(columns[0].clientOnly, true)
	assert.equal(meta.fields[0].fieldtype, "Table")
})
