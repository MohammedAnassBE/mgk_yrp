import test from "node:test"
import assert from "node:assert/strict"
import { addEntry, addSplit, editorSavePayload, getItems, loadItems, replaceEntry } from "../src/item-editor/editorPayload.js"
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

test("split retains DC source links independently for occupied and prefilled size cells", () => {
	const groups = fixture()
	const original = groups[0].items[0]
	original.values.S.delivery_challan_item = "DC-row-S"
	original.values.M = { qty: 0, is_prefilled: 1, delivery_challan_item: "DC-row-M" }
	original.values.L = { qty: 0 }
	original.values.XL = null
	addSplit(groups, 0, 0)
	const split = groups[0].items[1]
	assert.equal(split.row_index, undefined)
	for (const key of ["S", "M"]) {
		assert.equal(split.values[key].qty, 0)
		assert.equal(split.values[key].amount, 0)
		assert.equal(split.values[key].is_prefilled, 1)
		assert.equal(split.values[key].delivery_challan_item, `DC-row-${key}`)
		assert.equal(split.values[key].name, undefined)
	}
	assert.equal(split.values.L, null)
	assert.equal(split.values.XL, null)
	split.attributes.Colour = "Blue"
	split.dimensions.received_type = "Rejected"
	assert.equal(original.attributes.Colour, "Red")
	assert.equal(original.dimensions.received_type, "Accepted")
	assert.equal(original.values.S.qty, 4)
	const payload = editorSavePayload({ doctype: "MGK Goods Received Note", docstatus: 0 }, groups)
	assert.deepEqual(loadItems(payload.item_details, "grn_job"), groups)
	assert.deepEqual(payload.items, [])
})

test("zero-quantity prefilled job-work drafts survive save even before any receipt quantity is entered", () => {
	const groups = fixture()
	const cell = groups[0].items[0].values.S
	Object.assign(cell, { qty: 0, is_prefilled: 1, delivery_challan_item: "DC-source" })
	const doc = { doctype: "MGK Goods Received Note", docstatus: 0 }
	const payload = editorSavePayload(doc, groups)
	assert.deepEqual(JSON.parse(payload.item_details), groups)
	assert.throws(() => editorSavePayload({ ...doc, against_purchase_order: 1 }, groups), /Enter Qty/)
	assert.throws(() => editorSavePayload({ ...doc, docstatus: 1 }, groups), /Enter Qty/)
	delete cell.is_prefilled
	assert.throws(() => editorSavePayload(doc, groups), /Enter Qty/)
})
