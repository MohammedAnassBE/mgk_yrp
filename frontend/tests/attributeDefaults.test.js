import test from "node:test"
import assert from "node:assert/strict"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { clearReadCaches } from "../src/api/client.js"
import { editorPermissions } from "../src/item-editor/editorModes.js"
import { defaultAttributes } from "../src/item-editor/attributeValues.js"
import { fieldQuery } from "../src/document/fieldQueries.js"
import { childChange } from "../src/masters/masterFields.js"

const inputs = (root) => nodes(root, (node) => node.tag === "input")
const button = (root, label) => nodes(root, (node) => node.tag === "button" && textContent(node) === label)[0]
const details = { item: "Shirt", attributes: ["Size", "Colour", "Fit"], primary_attribute: "Size", primary_attribute_values: ["S"],
	default_uom: "Nos", attribute_defaults: { Colour: "Red" } }

function mockFetch(detailsMessage = details) {
	const original = globalThis.fetch
	globalThis.fetch = async (url) => {
		const message = url.includes("get_attribute_details") ? detailsMessage
			: url.includes("search_item_attribute_values") ? [{ value: "Blue", tamil: "" }, { value: "Slim", tamil: "" }]
				: [{ value: "Shirt" }]
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	return () => { globalThis.fetch = original; clearReadCaches() }
}

async function selectFirst(root, input) {
	await input.props.onFocus()
	await settle()
	nodes(root, (node) => node.tag === "li")[0].props.onMousedown({ preventDefault() {} })
	await settle()
}

async function addItem(mode, chooseFit = true, changeColour = false) {
	const committed = []
	const page = await mountComponent("../../src/item-editor/StockItemEntry.vue", { mode, defaults: {}, dimensions: [],
		permissions: editorPermissions(mode), poEntries: [], onCommit: (group, entry) => committed.push(entry) })
	try {
		await selectFirst(page.root, inputs(page.root)[0])
		const [colour, fit] = inputs(page.root).slice(1, 3)
		const prefilled = { colour: colour.props.value, fit: fit.props.value }
		if (changeColour) await selectFirst(page.root, colour)
		if (chooseFit) await selectFirst(page.root, inputs(page.root)[2])
		const numbers = inputs(page.root).filter((node) => node.props.role !== "combobox")
		numbers.forEach((number, index) => number.props.onInput({ target: { value: index ? "10" : "3" } }))
		await settle()
		await button(page.root, "Add item").props.onClick()
		await settle()
		return { prefilled, committed }
	} finally { page.close() }
}

test("defaultAttributes keeps only non-primary attributes that have a default", () => {
	assert.deepEqual(defaultAttributes({ ...details, attribute_defaults: { Size: "S", Colour: "Red", Other: "X" } }), { Colour: "Red" })
	assert.deepEqual(defaultAttributes({ attributes: ["Colour"] }), {})
})

for (const mode of ["po", "dc", "grn_job", "plan"]) {
	test(`new ${mode} line prefills defaults and leaves attributes without one empty`, async () => {
		const restore = mockFetch()
		try {
			const { prefilled, committed } = await addItem(mode)
			assert.deepEqual(prefilled, { colour: "Red", fit: "" })
			assert.deepEqual(committed[0].attributes, { Colour: "Red", Fit: "Blue" })
		} finally { restore() }
	})
}

test("a user's change to a prefilled attribute is kept", async () => {
	const restore = mockFetch()
	try {
		const { committed } = await addItem("po", true, true)
		assert.equal(committed[0].attributes.Colour, "Blue")
	} finally { restore() }
})

test("an item without defaults starts with empty attributes", async () => {
	const restore = mockFetch({ ...details, attribute_defaults: {} })
	try {
		const { prefilled } = await addItem("po", false)
		assert.deepEqual(prefilled, { colour: "", fit: "" })
	} finally { restore() }
})

test("editing a mapped line keeps its blank attribute instead of the default", async () => {
	const restore = mockFetch()
	const entry = { name: "Shirt", attributes: { Colour: "", Fit: "Slim" }, dimensions: {}, values: { S: { qty: 2 } }, default_uom: "Nos" }
	const page = await mountComponent("../../src/item-editor/StockItemEntry.vue", { mode: "grn_job", defaults: {}, dimensions: [],
		permissions: editorPermissions("grn_job"), poEntries: [], editing: { group: details, entry } })
	try {
		await settle()
		const [colour, fit] = inputs(page.root).slice(1, 3)
		assert.deepEqual([colour.props.value, fit.props.value], ["", "Slim"])
	} finally { page.close(); restore() }
})

test("item master Default Value searches the row's attribute values and resets when the attribute changes", () => {
	const query = fieldQuery({ fieldname: "mgk_default_value" }, { parent: "Shirt", attribute: "Colour" })
	assert.equal(query.searchMethod, "mgk_yrp.stock.attribute_values.search_item_attribute_values")
	assert.deepEqual(query.searchArgs, { item: "Shirt", attribute: "Colour" })
	assert.equal(query.allowCreate, false)
	assert.equal(query.displayValue("Red"), "Red")
	const row = { attribute: "Colour", mgk_default_value: "Red" }
	assert.deepEqual(childChange(row, "attribute", "Fit", []), { attribute: "Fit", mgk_default_value: null })
	assert.deepEqual(childChange(row, "attribute", "Colour", []), { attribute: "Colour" })
})
