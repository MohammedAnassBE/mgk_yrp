import test from "node:test"
import assert from "node:assert/strict"
import { deliveryChallanChanges, createFieldEvents as dcEvents, processFilters } from "../src/documents/delivery-challan/fieldEvents.js"
import { actions as dcActions } from "../src/documents/delivery-challan/actions.js"
import { intro, summary, valuationChip } from "../src/documents/delivery-challan-close/presentation.js"
import { createFieldEvents as closeEvents } from "../src/documents/delivery-challan-close/fieldEvents.js"
import { actions as closeActions, finishReopen, reopenConfirmation } from "../src/documents/delivery-challan-close/actions.js"
import { editorMode, editorPermissions } from "../src/item-editor/editorModes.js"
import { editorSavePayload } from "../src/item-editor/editorPayload.js"
import { fieldState } from "../src/document/fieldConditions.js"
import { fieldQuery } from "../src/document/fieldQueries.js"
import { documentLayout } from "../src/document/documentLayout.js"
import { canAmendDocument } from "../src/document/lifecycle.js"
import { openMappedDraft, readMappedDraft } from "../src/document/mappedDraft.js"
import { readFile } from "node:fs/promises"

const dcType = "MGK Delivery Challan"
const closeType = "MGK Delivery Challan Close"

test("DC locations clear warehouses, warehouse filters include the party and exclude disabled/group rows, returns stay locked", async () => {
	for (const side of ["from", "to"]) {
		assert.deepEqual(deliveryChallanChanges(`${side}_location`, {}), { [`${side}_warehouse`]: null })
		assert.deepEqual(deliveryChallanChanges(`${side}_location`, { is_return: 1 }), {})
		assert.deepEqual(fieldQuery({ fieldname: `${side}_warehouse`, options: "Warehouse" }, { [`${side}_location`]: "Vendor" }),
			{ filters: { supplier: "Vendor", disabled: 0, is_group: 0 } })
	}
	const meta = JSON.parse(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_delivery_challan/mgk_delivery_challan.json", import.meta.url)))
	for (const name of ["from_location", "from_warehouse", "to_location", "to_warehouse", "process_name"]) {
		assert.equal(fieldState(meta.fields.find((field) => field.fieldname === name), { is_return: 1 }, meta, { name: "Administrator" }).readOnly, true)
	}
	assert.equal(editorMode({ doctype: dcType, is_return: 1 }), "dc_return")
	assert.deepEqual(editorPermissions("dc_return"), { canCreate: false, canEdit: false, canRemove: false,
		rateEditable: false, lockDimensionsOnEdit: true, inlineQtyMaxField: "allowed_qty" })
	const groups = [{ items: [{ name: "Yarn", values: { default: { qty: 2, rate: 0, against_dc_item: "source-row", allowed_qty: 3 } } }] }]
	const payload = editorSavePayload({ doctype: dcType, is_return: 1 }, groups)
	assert.deepEqual(payload.items, [])
	assert.equal(JSON.parse(payload.item_details)[0].items[0].values.default.against_dc_item, "source-row")
})

test("DC process default uses actual enable fields, fills only one candidate, preserves explicit choice and mapped return", async () => {
	assert.deepEqual(processFilters({ fields: [{ fieldname: "enabled" }] }), { enabled: 1 })
	assert.deepEqual(processFilters({ fields: [{ fieldname: "disabled" }] }), { disabled: 0 })
	assert.deepEqual(processFilters({ fields: [] }), {})
	for (const count of [0, 1, 2]) {
		const doc = { doctype: dcType, docstatus: 0, __islocal: 1 }
		const auto = [], candidates = []
		const events = dcEvents({ getDoc: () => doc,
			getMeta: async () => [{ name: "YRP Process", fields: [{ fieldname: "enabled" }] }],
			call: async (method, args) => { assert.deepEqual(args.filters, { enabled: 1 }); return Array.from({ length: count }, (_, index) => ({ name: `Process-${index}` })) },
			markAuto: (fields) => auto.push(...fields), setCandidates: (field, values) => candidates.push(...values) })
		await events.load()
		assert.equal(doc.process_name, count === 1 ? "Process-0" : undefined)
		assert.equal(candidates.length, count)
		assert.deepEqual(auto, count === 1 ? ["process_name"] : [])
	}
	for (const flags of [{ is_return: 1 }, { process_name: "Explicit" }]) {
		await dcEvents({ getDoc: () => ({ __islocal: 1, ...flags }), getMeta: () => assert.fail("preserve mapped/explicit process") }).load()
	}
})

test("DC Return/Close actions gate status and permissions and stage mapped drafts on the correct route", async () => {
	const doc = { doctype: dcType, name: "DC-1", docstatus: 1, close_status: "Open" }
	assert.deepEqual(dcActions(doc, () => true).map((action) => action.key), ["return", "close"])
	for (const flags of [{ docstatus: 0 }, { docstatus: 2 }, { is_return: 1 }, { close_status: "Closed" }, { close_status: "Reopening" }]) {
		assert.deepEqual(dcActions({ ...doc, ...flags }, () => true), [])
	}
	assert.deepEqual(dcActions(doc, (doctype) => doctype === closeType).map((action) => action.key), ["close"])
	assert.deepEqual(dcActions({ ...doc, delivery_challan_close: "C/1" }, () => false), [])
	assert.equal(dcActions({ ...doc, delivery_challan_close: "C/1" }, () => true).at(-1).to, "/delivery-challan-close/C%2F1")
	const store = new Map(), storage = { setItem: (key, value) => store.set(key, value), getItem: (key) => store.get(key) }
	for (const action of dcActions(doc, () => true)) {
		const target = { doctype: action.key === "return" ? dcType : closeType, delivery_challan: doc.name, is_return: action.key === "return" ? 1 : 0 }
		await openMappedDraft(action, doc.name, { storage, call: async (method, args) => {
			assert.equal(method, "frappe.model.mapper.make_mapped_doc")
			assert.equal(args.source_name, "DC-1")
			assert.ok(args.method.endsWith(action.key === "return" ? "make_return_delivery_challan" : "make_delivery_challan_close"))
			return target
		}, navigate: async (route) => {
			assert.equal(route.path, `${action.route}/new`)
			assert.deepEqual(readMappedDraft(route.query.draft, target.doctype, storage), target)
		} })
	}
})

test("Close previews on draft load and source selection, drops stale results, and never previews submitted closes", async () => {
	let doc = { doctype: closeType, docstatus: 0, delivery_challan: "DC-1" }, finish
	const calls = []
	const events = closeEvents({ getDoc: () => doc, callDoc: async (record, method) => {
		calls.push(method)
		return new Promise((resolve) => { finish = resolve })
	} })
	const first = events.load()
	assert.deepEqual(calls, ["preview"])
	doc.delivery_challan = "DC-2"
	finish({ doc: { supplier: "Wrong" } }); await first
	assert.equal(doc.supplier, undefined)
	const second = events.change("delivery_challan")
	finish({ doc: { supplier: "Worker", warehouse: "W2", items: [{ item: "Yarn" }], outputs: [{ item: "Fabric" }], value_per_unit: 10 } }); await second
	assert.equal(doc.supplier, "Worker")
	assert.equal(doc.outputs.length, 1)
	doc = { doctype: closeType, docstatus: 1, delivery_challan: "DC-2" }
	await events.load()
	assert.equal(calls.length, 2)
	assert.deepEqual(fieldQuery({ fieldname: "delivery_challan" }, {}), { filters: { docstatus: 1, is_return: 0, close_status: "Open" } })
})

test("Close intro text matches Desk for draft, at-close, write-off, reversing and reopened variants", () => {
	const doc = { docstatus: 0, outputs: [{}], value_per_unit: 2500 / 60, output_stock_uom: "Kg", loss_value: 125 }
	assert.equal(intro(doc).text, "Adds ₹41.67 per Kg to 1 GRN rows")
	assert.equal(intro({ ...doc, docstatus: 1 }).text, "At close: added ₹41.67 per Kg to 1 GRN rows")
	assert.equal(intro({ ...doc, outputs: [] }).text, "No linked GRN: ₹125.00 will be written off")
	assert.equal(intro({ ...doc, docstatus: 2, outputs: [] }).text, "At close: ₹125.00 was written off (no linked GRN)")
	for (const reopen_status of ["Reversing", "Reopening"]) assert.deepEqual(intro({ ...doc, reopen_status }), {
		text: "Reversing valuation; consumption will be cancelled when the reversal completes.", severity: "warn",
	})
	assert.deepEqual(intro({ ...doc, reopen_status: "Reopened" }), { text: "Delivery Challan reopened.", severity: "success" })
	for (const status of ["Completed", "Reversed", "Queued", "Reversal Queued"]) assert.equal(valuationChip({ __onload: { valuation_status: status } }).className,
		["Completed", "Reversed"].includes(status) ? "status-completed" : "status-pending")
	assert.equal(valuationChip({}), null)
	assert.ok(summary({ docstatus: 1 }).lines.some((line) => line.label === "Value Per Unit at Close"))
	assert.equal(summary({ docstatus: 0 }).lines.some((line) => line.label === "Total Value Gap"), false)
	assert.equal(documentLayout(closeType, { fields: [] }).gridForm, true)
})

test("Finish Reopen uses close_name, reports pending reversal, reloads and requires cancel permission", async () => {
	const doc = { doctype: closeType, name: "CLOSE-1", docstatus: 2, reopen_status: "Reversing", delivery_challan: "DC-1" }
	assert.equal(reopenConfirmation(doc), "Reopen Delivery Challan DC-1? Its valuation will be reversed before stock is released.")
	assert.equal(closeActions(doc, () => true)[0].key, "finish-reopen")
	assert.deepEqual(closeActions(doc, () => false), [])
	for (const result of [false, true]) {
		const effects = []
		await finishReopen(doc, { call: async (method, args) => {
			assert.equal(method, "mgk_yrp.job_work.reopen.finish_reopen")
			assert.deepEqual(args, { close_name: "CLOSE-1" }); return result
		}, message: (message) => effects.push(message), reload: async () => effects.push("reload") })
		assert.deepEqual(effects, result ? ["reload"] : ["The reversal is still processing.", "reload"])
	}
	for (const reopen_status of ["Reversing", "Reopening"]) assert.equal(canAmendDocument({ ...doc, reopen_status }, () => true), false)
	assert.equal(canAmendDocument({ ...doc, reopen_status: "Reopened" }, () => true), true)
})
