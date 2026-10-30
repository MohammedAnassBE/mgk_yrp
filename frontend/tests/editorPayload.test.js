import test from "node:test"
import assert from "node:assert/strict"
import { addEntry, editorSavePayload, getItems, loadItems, replaceEntry } from "../src/item-editor/editorPayload.js"
import { amendmentDraft } from "../src/document/mappedDraft.js"

function fixture() {
	return [{ attributes: ["Colour"], primary_attribute: "Size", primary_attribute_values: ["S", "M"], group_extra: { keep: 1 }, items: [{
		name: "Yarn", attributes: { Colour: "Red" }, primary_attribute: "Size", dimensions: { received_type: "Accepted", lot: "L1" },
		default_uom: "Kg", row_index: "row-index", table_index: 8, unknown_entry: [1, 2], values: {
			S: { name: "child-S", qty: 4, rate: 5, amount: 20, uom: "Bag", stock_uom: "Kg", conversion_factor: 10, received_qty: 1, pending_qty: 3, allowed_qty: 4, purchase_order_item: "POI-1", against_dc_item: "DCI-1", unknown_cell: { keep: true } },
			M: null,
		},
	}] }]
}

test("persisted primary-attribute payload survives repeated load/edit/get/save without losing any key", () => {
	const source = fixture()
	let loaded = loadItems(JSON.stringify(source), "po")
	assert.deepEqual(getItems(loaded), source)
	const entry = getItems(loaded)[0].items[0]
	entry.values.S.qty = 6
	entry.values.S.amount = 30
	replaceEntry(loaded, 0, 0, entry)
	const expected = fixture()
	expected[0].items[0].values.S.qty = 6
	expected[0].items[0].values.S.amount = 30
	for (let index = 0; index < 5; index++) {
		const payload = editorSavePayload({ doctype: "MGK Purchase Order", items: [{ name: "stale child" }] }, loaded)
		assert.deepEqual(payload.items, [])
		assert.deepEqual(JSON.parse(payload.item_details), expected)
		loaded = loadItems(payload.item_details, "po")
	}
	assert.deepEqual(source, fixture())
})

test("two entries split from one PO row and return rows preserve identities independently", () => {
	for (const mode of ["grn_po", "dc_return"]) {
		const groups = fixture()
		const second = structuredClone(groups[0].items[0])
		second.dimensions.received_type = "Rejected"
		second.values.S.name = "child-rejected"
		groups[0].items.push(second)
		assert.deepEqual(getItems(loadItems(groups, mode)), groups)
	}
})

test("local cell names are stripped but persistent names and unknown keys remain", () => {
	const groups = fixture()
	groups[0].items[0].values.M = { name: "new-local", qty: 2, unknown: "keep" }
	const loaded = loadItems(groups, "po")
	assert.deepEqual(loaded[0].items[0].values.M, { qty: 2, unknown: "keep" })
	assert.equal(loaded[0].items[0].values.S.name, "child-S")
	assert.equal(groups[0].items[0].values.M.name, "new-local")
})

test("amendment keeps source row links and dimensions while removing child identities for hydration", () => {
	const doc = { doctype: "MGK Goods Received Note", name: "GRN-1", docstatus: 2, amended_from: "GRN-0", items: [{ name: "child", item: "Yarn", purchase_order_item: "POI-1", received_type: "Fresh", qty: 3 }], __onload: { item_details: fixture() } }
	const draft = amendmentDraft(doc)
	assert.equal(draft.amended_from, "GRN-1")
	assert.equal(draft.items[0].name, undefined)
	assert.equal(draft.items[0].purchase_order_item, "POI-1")
	assert.equal(draft.items[0].received_type, "Fresh")
	assert.equal(draft.__onload, undefined)
	assert.equal(doc.items[0].name, "child")
})

test("new entries retain unknown keys and empty quantity is blocked before save", () => {
	const groups = fixture()
	const entry = structuredClone(groups[0].items[0])
	entry.extra = "custom"
	addEntry(groups, groups[0], entry)
	assert.deepEqual(groups[0].items[1], entry)
	assert.throws(() => editorSavePayload({}, []), /Enter Qty/)
})
