import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { reactive } from "vue"
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { formatFieldValue } from "../src/document/fieldDisplay.js"
import { groupGrnRows } from "../src/documents/purchase-invoice/fieldEvents.js"
import { clearReadCaches } from "../src/api/client.js"
import { documentLayout } from "../src/document/documentLayout.js"
import { fieldState } from "../src/document/fieldConditions.js"
import { getRows } from "../src/list/listApi.js"

test("billing shows only paper columns, two-decimal currencies and the tax columns matching tax_type", async () => {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { user: { name: "Administrator" } } } }
	const child = JSON.parse(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_purchase_invoice_item/mgk_purchase_invoice_item.json", import.meta.url)))
	const doc = { items: [{ item: "Yarn", qty: 2, uom: "Kg", grn_rate: 50, rate: 50, amount: 100, gst_rate: 5, cgst_amount: 2.5, sgst_amount: 2.5, igst_amount: 5, goods_received_note: "GRN-1" }] }
	const props = reactive({ doc, groups: groupGrnRows(doc.items), metas: [child], meta: { permissions: [] }, disabled: true })
	const page = await mountComponent("../../src/documents/purchase-invoice/InvoiceRows.vue", props)
	try {
		for (const [type, taxColumns] of [["CGST + SGST", ["CGST", "SGST"]], ["IGST", ["IGST"]], ["No Tax", []]]) {
			props.doc.tax_type = type
			await settle()
			assert.deepEqual(nodes(page.root, (node) => node.tag === "th").map(textContent), ["Item", "Quantity", "UOM", "GRN Rate", "Rate", "Amount", "GST %", ...taxColumns])
			const values = nodes(page.root, (node) => node.tag === "td").map(textContent)
			assert.deepEqual(values.slice(3, 6), ["50.00", "50.00", "100.00"])
			assert.ok(nodes(page.root, (node) => node.tag === "td" && node.props.class.includes("numeric")).length >= 5)
		}
	} finally { page.close(); globalThis.window = original }
})

test("normal DC details omit Is Return and Return Against is visible and readonly only on returns", () => {
	const meta = { permissions: [], fields: ["is_return", "return_against"].map((fieldname) => ({ fieldname, fieldtype: fieldname === "is_return" ? "Check" : "Link" })) }
	const layout = documentLayout("MGK Delivery Challan", meta)
	assert.equal(layout.panel.some((field) => field.fieldname === "is_return"), false)
	const field = layout.panel.find((field) => field.fieldname === "return_against")
	assert.equal(fieldState(field, { is_return: 0 }, meta, { name: "Administrator" }).visible, false)
	assert.equal(fieldState(field, { is_return: 1 }, meta, { name: "Administrator" }).visible, true)
	assert.equal(fieldState(field, { is_return: 1 }, meta, { name: "Administrator" }).readOnly, true)
})

test("all currencies in read surfaces force two decimals even when Desk precision is six", () => {
	assert.equal(formatFieldValue({ fieldtype: "Currency", precision: "6" }, 50), "50.00")
	assert.equal(formatFieldValue({ fieldtype: "Currency", precision: "6" }, 1234.56789), "1,234.57")
	assert.equal(formatFieldValue({ fieldtype: "Currency" }, 0), "0.00")
	assert.equal(formatFieldValue({ fieldtype: "Float", precision: "6" }, 1.234567), "1.234567")
})

test("Date, Time and Datetime controls expose the actual field label as their accessible name", async () => {
	for (const fieldtype of ["Date", "Time", "Datetime"]) {
		const page = await mountComponent("../../src/document/fields/FieldControl.vue", {
			field: { fieldname: "posting", label: `Posting ${fieldtype}`, fieldtype }, doc: {}, meta: {}, metas: [], user: { name: "Administrator" },
		})
		try { assert.equal(nodes(page.root, (node) => node.tag === "input")[0].props["aria-label"], `Posting ${fieldtype}`) }
		finally { page.close() }
	}
})

test("Dynamic Link control searches the selected DocType and disables an unbound target", async () => {
	const original = globalThis.fetch
	const requested = []
	globalThis.fetch = async (url) => { requested.push(new URL(url, "http://site").searchParams.get("doctype")); return { ok: true, status: 200, json: async () => ({ message: [] }) } }
	const props = reactive({ field: { fieldname: "link_name", label: "Link Name", fieldtype: "Dynamic Link", options: "link_doctype" }, doc: { link_doctype: "Supplier" }, meta: {}, metas: [], user: { name: "Administrator" } })
	const page = await mountComponent("../../src/document/fields/FieldControl.vue", props)
	try {
		await nodes(page.root, (node) => node.tag === "input")[0].props.onFocus(); await settle()
		props.doc.link_doctype = "MGK Agent"
		await settle()
		await nodes(page.root, (node) => node.tag === "input")[0].props.onFocus(); await settle()
		assert.deepEqual(requested, ["Supplier", "MGK Agent"])
		props.doc.link_doctype = ""
		await settle()
		assert.equal(nodes(page.root, (node) => node.tag === "input")[0].props.disabled, true)
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("all new routed Vue surfaces compile without a Vite build", async () => {
	for (const path of ["books/stock/StockListPage.vue", "books/masters/MastersListPage.vue", "masters/MasterListPage.vue", "masters/MasterFormPage.vue", "masters/MasterEntry.vue", "masters/UserAccess.vue", "masters/PartyAddresses.vue"]) {
		const filename = new URL(`../src/${path}`, import.meta.url)
		const { descriptor, errors } = parse(await readFile(filename, "utf8"), { filename: path })
		assert.deepEqual(errors, [])
		const script = compileScript(descriptor, { id: path })
		const template = compileTemplate({ source: descriptor.template.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } })
		assert.deepEqual(template.errors, [], path)
	}
})

test("User access loads Desk roles and Role Profiles, applies profile roles atomically and locks profile-managed roles", async () => {
	const original = { window: globalThis.window, fetch: globalThis.fetch }
	globalThis.window = { frappe: { boot: { user: { roles: ["System Manager"] } } } }
	const requests = []
	globalThis.fetch = async (url) => {
		requests.push(url)
		const message = url.includes("get_all_roles") ? ["Stock User", "Stock Manager"]
			: url.includes("get_list") ? [{ name: "Inventory" }] : { roles: [{ role: "Stock Manager" }] }
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	const props = reactive({ doc: { roles: [{ name: "existing-role", role: "Stock User" }], role_profiles: [] },
		onChange: (name, value) => { props.doc[name] = value } })
	const page = await mountComponent("../../src/masters/UserAccess.vue", props)
	try {
		assert.ok(requests.some((url) => url.includes("frappe.core.doctype.user.user.get_all_roles")))
		assert.equal(nodes(page.root, (node) => node.tag === "input" && node.props.type === "checkbox").length, 2)
		await nodes(page.root, (node) => node.tag === "select")[0].props.onChange({ target: { values: ["Inventory"] } })
		await settle()
		assert.deepEqual(props.doc.role_profiles, [{ doctype: "User Role Profile", role_profile: "Inventory" }])
		assert.deepEqual(props.doc.roles, [{ doctype: "Has Role", role: "Stock Manager" }])
		assert.ok(nodes(page.root, (node) => node.tag === "input" && node.props.type === "checkbox").every((node) => node.props.disabled))
		await nodes(page.root, (node) => node.tag === "select")[0].props.onChange({ target: { values: [] } })
		await settle()
		assert.deepEqual(props.doc.role_profiles, [])
		props.disabled = true
		await settle()
		assert.ok(nodes(page.root, (node) => node.tag === "input" && node.props.type === "checkbox").every((node) => node.props.disabled))
	} finally { page.close(); Object.assign(globalThis, original); clearReadCaches() }
})

test("Address list links are loaded in permission-checked batches without selecting child tables as SQL columns", async () => {
	const original = globalThis.fetch
	const requests = []
	globalThis.fetch = async (url) => {
		const params = new URL(url, "http://site").searchParams
		if (url.startsWith("/api/resource/")) return { ok: true, status: 200, json: async () => ({ data: Array.from({ length: 501 }, (_, index) => ({ name: `Address-${index}` })) }) }
		const names = JSON.parse(params.get("names"))
		requests.push(names)
		return { ok: true, status: 200, json: async () => ({ message: Object.fromEntries(names.map((name) => [name, `Supplier: ${name}`])) }) }
	}
	try {
		const rows = await getRows("Address", { fields: ["name", "city"], limit: 501 })
		assert.deepEqual(requests.map((names) => names.length), [500, 1])
		assert.equal(rows[0].links, "Supplier: Address-0")
		assert.equal(rows[500].links, "Supplier: Address-500")
	} finally { globalThis.fetch = original; clearReadCaches() }
})
