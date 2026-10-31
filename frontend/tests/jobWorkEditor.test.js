import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { reactive, ref } from "vue"
import { mountComponent, nodes, settle, textContent } from "./helpers/component.js"
import { clearReadCaches } from "../src/api/client.js"
import { columnOptions, nonPrimaryAttributes, refreshEntryUom, setCellValue } from "../src/item-editor/attributeColumns.js"
import { editorSavePayload } from "../src/item-editor/editorPayload.js"

const button = (root, label) => nodes(root, (node) => node.tag === "button" && textContent(node) === label)[0]
const select = (root, label) => nodes(root, (node) => node.tag === "select" && node.props["aria-label"] === label)[0]
const input = (root, label) => nodes(root, (node) => node.tag === "input" && node.props["aria-label"] === label)[0]
const dimension = { fieldname: "received_type", label: "Received type", options: "YRP Received Type", mandatory: 1 }

function fixture() {
	return [{ attributes: ["Colour", "Size"], primary_attribute: "Size", primary_attribute_values: ["S", "M"],
		dependent_attribute: "Colour", dependent_attribute_details: { attr_list: { Blue: { uom: "Cone" } } }, items: [{
			name: "Yarn", row_index: "source", attributes: { Colour: "Raw" }, dimensions: { received_type: "Accepted" }, default_uom: "Kg",
			values: { S: { name: "GRN-S", qty: 5, rate: 2, uom: "Kg", delivery_challan_item: "DC-S" },
				M: { qty: 0, is_prefilled: 1, uom: "Kg", delivery_challan_item: "DC-M" } },
		}] }]
}

function mockFetch(overrides = () => undefined) {
	const original = globalThis.fetch
	const requests = []
	globalThis.fetch = async (url, options) => {
		const parsed = new URL(url, "http://site")
		const method = parsed.pathname.split("/").at(-1)
		const args = Object.fromEntries(parsed.searchParams)
		requests.push({ method, args, options })
		if (method === "frappe.desk.form.load.getdoctype") return { ok: true, status: 200, json: async () => ({ docs: [{ name: args.doctype }] }) }
		let message = overrides(method, args)
		if (message === undefined) {
			if (method === "mgk_yrp.stock.item_editor.get_editor_context") message = { defaults: { received_type: "Accepted" }, po_entries: [] }
			else if (method === "yrp.stock.api.get_stock_dimensions_for_ui") message = [dimension]
			else if (method === "frappe.client.get") message = args.doctype === "Item Attribute"
				? { item_attribute_values: [{ attribute_value: "Blue" }, { attribute_value: "IAV-red" }] }
				: { attribute_value: "Red" }
			else if (method === "frappe.client.get_list") message = [{ name: "Accepted" }, { name: "Rejected" }]
			else throw new Error(`Unexpected request: ${method}`)
		}
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	return { requests, restore() { globalThis.fetch = original; clearReadCaches() } }
}

async function mountEditor(properties = {}) {
	const editor = ref(null)
	const page = await mountComponent("../../src/item-editor/MgkItemEditor.vue", {
		doc: { doctype: "MGK Goods Received Note", docstatus: 0 }, editable: true, itemDetails: fixture(), ref: editor, ...properties,
	})
	await settle(); await settle()
	return { ...page, editor }
}

test("attribute columns exclude the primary and keep current, legacy and server option values", () => {
	const group = fixture()[0]
	group.items[0].attributes.Grade = "A"
	assert.deepEqual(nonPrimaryAttributes(group), ["Colour", "Grade"])
	assert.deepEqual(columnOptions("Raw", ["Blue", "Red", "Blue", ""]), ["Raw", "Blue", "Red"])
})

test("job-work dropdowns load Desk attribute and dimension options and refresh dependent UOM", async () => {
	const network = mockFetch()
	const page = await mountEditor()
	try {
		const colour = select(page.root, "Colour")
		assert.deepEqual(colour.options.map((option) => option.props.value), ["Raw", "Blue", "Red"])
		assert.equal(select(page.root, "Size"), undefined)
		assert.deepEqual(select(page.root, "Received type").options.map((option) => option.props.value), ["Accepted", "Rejected"])
		colour.props.onChange({ target: { value: "Blue" } })
		select(page.root, "Received type").props.onChange({ target: { value: "Rejected" } })
		await settle()
		const entry = page.editor.value.getItems()[0].items[0]
		assert.equal(entry.attributes.Colour, "Blue")
		assert.equal(entry.dimensions.received_type, "Rejected")
		assert.equal(entry.values.S.uom, "Cone")
		assert.equal(entry.values.M.uom, "Cone")
		assert.equal(network.requests.find((request) => request.method === "frappe.client.get_list").args.limit_page_length, "0")
	} finally { page.close(); network.restore() }
})

test("column option failures show the original error and Retry loads the dropdown", async () => {
	let isFailing = true
	const network = mockFetch((method) => {
		if (isFailing && method === "frappe.client.get") throw new Error("Attribute information changed. Reload this page.")
	})
	const page = await mountEditor()
	try {
		assert.ok(textContent(page.root).includes("Attribute information changed. Reload this page."))
		isFailing = false
		button(page.root, "Retry column options").props.onClick()
		await settle(); await settle()
		assert.equal(textContent(page.root).includes("Attribute information changed. Reload this page."), false, textContent(page.root))
		assert.equal(nodes(page.root, (node) => node.props.role === "alert").length, 0)
		assert.deepEqual(select(page.root, "Colour").options.map((option) => option.props.value), ["Raw", "Blue", "Red"])
	} finally { page.close(); network.restore() }
})

test("Add Split picks a source line and saves independent zero-quantity cells with their DC links", async () => {
	const network = mockFetch()
	const totals = []
	const page = await mountEditor({ onChange: (value) => totals.push(value) })
	try {
		button(page.root, "Add Split").props.onClick()
		await settle()
		const dialog = nodes(page.root, (node) => node.tag === "dialog")[0]
		const line = select(dialog, "Line")
		assert.equal(button(dialog, "Add Split").props.disabled, true)
		line.props.onChange({ target: { value: line.options[0].props.value } })
		await settle()
		button(dialog, "Add Split").props.onClick()
		await settle()
		assert.equal(nodes(page.root, (node) => node.tag === "dialog").length, 0)
		const groups = page.editor.value.getItems()
		const split = groups[0].items[1]
		assert.equal(split.row_index, undefined)
		for (const size of ["S", "M"]) {
			assert.equal(split.values[size].delivery_challan_item, `DC-${size}`)
			assert.equal(split.values[size].qty, 0)
			assert.equal(split.values[size].is_prefilled, 1)
			assert.equal(split.values[size].name, undefined)
		}
		const payload = editorSavePayload({ doctype: "MGK Goods Received Note", docstatus: 0 }, groups)
		assert.deepEqual(JSON.parse(payload.item_details), groups)
		assert.deepEqual(totals.at(-1), { total_qty: 5, total_amount: 10 })
	} finally { page.close(); network.restore() }
})

test("row split, Remove Selected, Remove and Remove All keep editor state and totals in sync", async () => {
	const network = mockFetch()
	const totals = []
	const page = await mountEditor({ onChange: (value) => totals.push(value) })
	try {
		nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Add Split")[1].props.onClick()
		await settle()
		input(page.root, "Select row 2").props.onChange({ target: { checked: true } })
		await settle()
		button(page.root, "Remove Selected (1)").props.onClick()
		await settle()
		assert.equal(page.editor.value.getItems()[0].items.length, 1)
		button(page.root, "Remove").props.onClick()
		await settle()
		assert.ok(textContent(page.root).includes("No items yet"))
		button(page.root, "Add Split").props.onClick()
		await settle()
		assert.ok(textContent(page.root).includes("Add an item before splitting."))
		button(page.root, "Remove All").props.onClick()
		await settle()
		assert.deepEqual(page.editor.value.getItems(), [])
		assert.deepEqual(totals.at(-1), { total_qty: 0, total_amount: 0 })
	} finally { page.close(); network.restore() }
})

test("plan mounts without a document, hides rate and amount, edits cells and can save an empty plan", async () => {
	const network = mockFetch()
	const page = await mountEditor({ doc: undefined, mode: "plan" })
	try {
		assert.equal(page.editor.value.isReady(), true)
		assert.equal(/Rate|Amount/.test(textContent(page.root)), false)
		assert.equal(input(page.root, "Yarn S rate"), undefined)
		input(page.root, "Yarn S quantity").props.onInput({ target: { value: "7" } })
		await settle()
		assert.equal(page.editor.value.getItems()[0].items[0].values.S.qty, 7)
		assert.ok(button(page.root, "Add item"))
		button(page.root, "Remove All").props.onClick()
		await settle()
		assert.equal(JSON.stringify(page.editor.value.getItems()), "[]")
	} finally { page.close(); network.restore() }
})

test("plan item entry hides rate after resolving a new item and retains dependent metadata", async () => {
	const network = mockFetch((method) => {
		if (method === "frappe.desk.search.search_link") return [{ value: "Yarn" }]
		if (method.endsWith("get_attribute_details")) return { attributes: [], dependent_attribute: "", default_uom: "Kg" }
	})
	const page = await mountEditor({ mode: "plan", itemDetails: [] })
	try {
		const item = nodes(page.root, (node) => node.tag === "input" && node.props.role === "combobox")[0]
		await item.props.onFocus(); await settle()
		nodes(page.root, (node) => node.tag === "li")[0].props.onMousedown({ preventDefault() {} })
		await settle()
		assert.equal(textContent(page.root).includes("Rate"), false)
		input(page.root, "Item quantity").props.onInput({ target: { value: "3" } })
		button(page.root, "Add item").props.onClick()
		await settle(); await settle()
		const group = page.editor.value.getItems()[0]
		assert.equal(group.dependent_attribute, "")
		assert.equal(group.items[0].values.default.qty, 3)
		assert.equal(group.items[0].default_uom, "Kg")
	} finally { page.close(); network.restore() }
})

test("plan payload prop reloads after an asynchronous response", async () => {
	const network = mockFetch()
	const props = reactive({ mode: "plan", editable: true, itemDetails: [] })
	const page = await mountComponent("../../src/item-editor/MgkItemEditor.vue", props)
	try {
		await settle()
		assert.ok(textContent(page.root).includes("No items yet"))
		props.itemDetails = JSON.stringify(fixture())
		await settle(); await settle()
		assert.ok(textContent(page.root).includes("Yarn"))
		assert.equal(textContent(page.root).includes("Rate"), false)
	} finally { page.close(); network.restore() }
})

test("internal read-only DC and GRN show transferred_qty from each actual child row", async () => {
	const network = mockFetch()
	try {
		for (const doctype of ["MGK Delivery Challan", "MGK Goods Received Note"]) {
			const rows = fixture()
			rows[0].items[0].values.M.name = "GRN-M"
			const page = await mountEditor({ editable: false, itemDetails: rows, doc: { doctype, docstatus: 1, is_internal_transfer: 1,
				items: [{ name: "GRN-M", transferred_qty: 1.5 }, { name: "GRN-S", transferred_qty: 3 }] } })
			try {
				assert.ok(textContent(page.root).includes("Transferred Qty"))
				assert.ok(textContent(page.root).includes("S: 3 Kg"))
				assert.ok(textContent(page.root).includes("M: 1.5 Kg"))
				assert.equal(nodes(page.root, (node) => ["input", "select", "button"].includes(node.tag)).length, 0)
			} finally { page.close() }
		}
		for (const options of [{ editable: true, doc: { is_internal_transfer: 1 } }, { editable: false }]) {
			const page = await mountEditor(options)
			try { assert.equal(textContent(page.root).includes("Transferred Qty"), false) }
			finally { page.close() }
		}
	} finally { network.restore() }
})

test("transferred quantity field matches DC and GRN child schemas", async () => {
	for (const child of ["delivery_challan", "goods_received_note"]) {
		const name = `mgk_${child}_item`
		const schema = JSON.parse(await readFile(new URL(`../../mgk_yrp/mgk_yrp/doctype/${name}/${name}.json`, import.meta.url), "utf8"))
		assert.ok(schema.fields.some((field) => field.fieldname === "transferred_qty" && field.read_only))
	}
})

test("missing or mixed-template UOM metadata clears stale units and empty cells stay empty", () => {
	const group = fixture()[0]
	group.items.push({ name: "Other Yarn" })
	refreshEntryUom(group, group.items[0])
	assert.equal(group.items[0].values.S.uom, "")
	assert.match(group.items[0].uom_hint, /resolved from the Item when saved/)
	const entry = { values: { S: null } }
	setCellValue(entry, "S", "qty", 0)
	assert.equal(entry.values.S, null)
	setCellValue(entry, "S", "qty", 2)
	assert.deepEqual(entry.values.S, { qty: 2, rate: 0, is_prefilled: 1 })
})
