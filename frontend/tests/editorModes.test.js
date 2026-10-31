import test from "node:test"
import assert from "node:assert/strict"
import { editorMode, editorPermissions, preparePurchaseOrderEntry, recalculate, usesAttributeColumns, validateItem } from "../src/item-editor/editorModes.js"

test("mode selection and independent Desk permission flags", () => {
	assert.equal(editorMode({ doctype: "MGK Purchase Order" }), "po")
	assert.equal(editorMode({ doctype: "MGK Delivery Challan" }), "dc")
	assert.equal(editorMode({ doctype: "MGK Delivery Challan", is_return: 1 }), "dc_return")
	assert.equal(editorMode({ against_purchase_order: 1 }), "grn_po")
	assert.equal(editorMode({ against_purchase_order: 0 }), "grn_job")
	for (const mode of ["po", "dc", "grn_job"]) assert.deepEqual(editorPermissions(mode), {
		canCreate: true, canEdit: true, canRemove: true, rateEditable: true, lockDimensionsOnEdit: false, inlineQtyMaxField: "",
	})
	assert.deepEqual(editorPermissions("grn_po"), { canCreate: true, canEdit: false, canRemove: false, rateEditable: false, lockDimensionsOnEdit: false, inlineQtyMaxField: "allowed_qty" })
	assert.deepEqual(editorPermissions("dc_return"), { canCreate: false, canEdit: false, canRemove: false, rateEditable: false, lockDimensionsOnEdit: true, inlineQtyMaxField: "allowed_qty" })
	for (const mode of ["po", "dc_return", "grn_po"]) {
		const flags = editorPermissions(mode, false)
		for (const flag of ["canCreate", "canEdit", "canRemove", "rateEditable"]) assert.equal(flags[flag], false)
	}
})

test("job-work and plan use attribute columns; plan is writable with rate hidden", () => {
	assert.equal(editorMode({ doctype: "MGK Process Planning" }), "plan")
	for (const mode of ["grn_job", "plan"]) assert.equal(usesAttributeColumns(mode), true)
	for (const mode of ["po", "dc", "dc_return", "grn_po"]) assert.equal(usesAttributeColumns(mode), false)
	assert.deepEqual(editorPermissions("plan"), { canCreate: true, canEdit: true, canRemove: true,
		rateEditable: false, lockDimensionsOnEdit: false, inlineQtyMaxField: "" })
	assert.equal(editorPermissions("plan", false).canCreate, false)
})

test("PO rows match by parent, attributes, primary cell and explicit source row, ignoring received type", () => {
	const source = { name: "Yarn", attributes: { Colour: "Red", Grade: "A" }, values: { S: { purchase_order_item: "POI-1", rate: 12, uom: "Kg", stock_uom: "Kg", conversion_factor: 1, pending_qty: 5, allowed_qty: 6 } } }
	const entry = { name: "Yarn", attributes: { Grade: "A", Colour: "Red" }, dimensions: { received_type: "Rejected" }, values: { S: { qty: 2, custom: "keep" } } }
	preparePurchaseOrderEntry(entry, [source])
	assert.equal(entry.values.S.purchase_order_item, "POI-1")
	assert.equal(entry.values.S.rate, 12)
	assert.equal(entry.values.S.custom, "keep")
	assert.equal(entry.dimensions.received_type, "Rejected")
	const other = structuredClone(source)
	other.values.S.purchase_order_item = "POI-2"
	assert.throws(() => preparePurchaseOrderEntry({ ...entry, values: { S: { qty: 1 } } }, [source, other]), /exactly one/)
	preparePurchaseOrderEntry(entry, [source, other])
	assert.throws(() => preparePurchaseOrderEntry({ ...entry, attributes: { Colour: "Blue" } }, [source]), /exactly one/)
})

test("PO rate validation and totals preserve dimensions and cell metadata", () => {
	const entry = { dimensions: { received_type: "Fresh" }, values: { S: { qty: 2, rate: 3, name: "row-1" }, M: { qty: 0, rate: 0 } } }
	assert.equal(validateItem(entry, "po"), true)
	assert.deepEqual(recalculate([{ items: [entry] }], "dc"), { total_qty: 2, total_declared_value: 6 })
	assert.deepEqual(recalculate([{ items: [entry] }], "po"), { total_qty: 2, total_amount: 6 })
	assert.equal(entry.values.S.name, "row-1")
	entry.values.S.rate = 0
	assert.throws(() => validateItem(entry, "po"), /greater than zero/)
	assert.equal(validateItem(entry, "grn_job"), true)
})
