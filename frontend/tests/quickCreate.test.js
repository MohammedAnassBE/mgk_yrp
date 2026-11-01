import test from "node:test"
import assert from "node:assert/strict"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { clearReadCaches } from "../src/api/client.js"
import { hasExactMatch, quickCreateForm } from "../src/document/fields/quickCreate.js"

const inputs = (root) => nodes(root, (node) => node.tag === "input")
const options = (root) => nodes(root, (node) => node.tag === "li")
const supplierMeta = { name: "Supplier", autoname: "naming_series:", title_field: "supplier_name", permissions: [], fields: [
	{ fieldname: "naming_series", fieldtype: "Select", reqd: 1, options: "SUP-.####", hidden: 1 },
	{ fieldname: "supplier_name", fieldtype: "Data", label: "Supplier Name", reqd: 1 },
	{ fieldname: "supplier_type", fieldtype: "Select", reqd: 1, options: "Company\nIndividual", default: "Company" },
	{ fieldname: "tax_id", fieldtype: "Data", label: "Tax ID" },
] }

function mockServer({ results = [], meta = supplierMeta, insert = { name: "SUP-0001" } } = {}) {
	const calls = []
	globalThis.fetch = async (url, options = {}) => {
		calls.push({ url, body: options.body && JSON.parse(options.body) })
		if (url.includes("getdoctype")) return { ok: true, status: 200, json: async () => ({ docs: [meta] }) }
		if (url.includes("frappe.client.insert")) {
			if (insert instanceof Error) return { ok: false, status: 417, json: async () => ({ exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message: insert.message })]) }) }
			return { ok: true, status: 200, json: async () => ({ message: insert }) }
		}
		return { ok: true, status: 200, json: async () => ({ message: results }) }
	}
	return calls
}

async function typeInto(page, value) {
	const input = inputs(page.root)[0]
	await input.props.onFocus()
	input.props.onInput({ target: { value } })
	await new Promise((resolve) => setTimeout(resolve, 250))
	await settle()
}

async function withLink(setup, run) {
	const original = globalThis.fetch
	const originalWindow = globalThis.window
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_create: setup.canCreate ?? ["Supplier"] } } } }
	const calls = mockServer(setup)
	const changes = []
	const page = await mountComponent("../../src/document/fields/LinkField.vue", { doctype: "Supplier", label: "Supplier",
		"onUpdate:modelValue": (value) => changes.push(value) })
	try { await run(page, calls, changes) } finally { page.close(); globalThis.fetch = original; globalThis.window = originalWindow; clearReadCaches() }
}

test("quick create row appears after results when the typed text has no exact match", () => withLink({ results: [{ value: "Acme Traders" }] }, async (page) => {
	await typeInto(page, "Acme")
	const rows = options(page.root)
	assert.equal(rows.length, 2)
	assert.equal(textContent(rows[1]), "+ Create a new Supplier: “Acme”")
	assert.equal(rows[0].props["aria-selected"], true)
}))

test("quick create row is hidden on an exact match or without create permission", async () => {
	await withLink({ results: [{ value: "SUP-1", description: "Acme" }] }, async (page) => {
		await typeInto(page, "acme")
		assert.equal(options(page.root).length, 1)
	})
	await withLink({ canCreate: [], results: [] }, async (page, calls) => {
		await typeInto(page, "Acme")
		assert.equal(options(page.root).length, 0)
		assert.equal(calls.some((call) => call.url.includes("getdoctype")), false)
	})
	await withLink({ results: [], meta: { ...supplierMeta, is_submittable: 1 } }, async (page) => {
		await typeInto(page, "Acme")
		assert.equal(options(page.root).length, 0)
	})
})

test("Enter on the only create row opens the popup and saving sets the new link value", () => withLink({ results: [] }, async (page, calls, changes) => {
	await typeInto(page, "Acme")
	const rows = options(page.root)
	assert.equal(rows.length, 1)
	assert.equal(rows[0].props["aria-selected"], true)
	inputs(page.root)[0].props.onKeydown({ key: "Enter", preventDefault() {} })
	await settle()
	const form = nodes(page.root, (node) => node.tag === "form")[0]
	assert.ok(form)
	await form.props.onSubmit({ preventDefault() {} })
	await settle()
	const insert = calls.find((call) => call.url.includes("frappe.client.insert"))
	assert.equal(insert.body.doc.doctype, "Supplier")
	assert.equal(insert.body.doc.supplier_name, "Acme")
	assert.equal(insert.body.doc.supplier_type, "Company")
	assert.deepEqual(changes, ["SUP-0001"])
	assert.equal(nodes(page.root, (node) => node.tag === "dialog").length, 0)
}))

test("quick create shows the server error inside the popup", () => withLink({ results: [], insert: new Error("Supplier Acme already exists") }, async (page, calls, changes) => {
	await typeInto(page, "Acme")
	options(page.root)[0].props.onMousedown({ preventDefault() {} })
	await settle()
	await nodes(page.root, (node) => node.tag === "form")[0].props.onSubmit({ preventDefault() {} })
	await settle()
	assert.match(textContent(nodes(page.root, (node) => node.tag === "dialog")[0]), /already exists/)
	assert.deepEqual(changes, [])
}))

test("quick create form shows the title field and empty mandatory fields with master defaults and filters", () => {
	const itemMeta = { name: "Item", autoname: "field:item_code", title_field: "item_name", permissions: [], fields: [
		{ fieldname: "item_code", fieldtype: "Data", reqd: 1 }, { fieldname: "item_name", fieldtype: "Data" },
		{ fieldname: "item_group", fieldtype: "Link", options: "Item Group", reqd: 1 },
		{ fieldname: "stock_uom", fieldtype: "Link", options: "UOM", reqd: 1 }, { fieldname: "description", fieldtype: "Text", reqd: 1 },
	] }
	const form = quickCreateForm("Item", [itemMeta], "Cotton", {}, { user: { name: "Administrator" } })
	assert.deepEqual(form.fields.map((field) => field.fieldname), ["item_name", "stock_uom"])
	assert.equal(form.draft.item_name, "Cotton")
	assert.equal(form.draft.item_group, "Products")
	const warehouse = { name: "Warehouse", permissions: [], fields: [{ fieldname: "warehouse_name", fieldtype: "Data", reqd: 1 },
		{ fieldname: "company", fieldtype: "Link", options: "Company", reqd: 1 }, { fieldname: "is_group", fieldtype: "Check" }] }
	const store = quickCreateForm("Warehouse", [warehouse], "Main", { is_group: 1 }, { user: { name: "Administrator" }, defaults: { company: "MGK" } })
	assert.deepEqual(store.fields.map((field) => field.fieldname), ["warehouse_name"])
	assert.equal(store.draft.company, "MGK")
	assert.equal(store.draft.is_group, 1)
	assert.equal(hasExactMatch([{ value: "W-1", description: "<b>Main</b>" }], " main "), true)
})
