import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { reactive, ref, shallowRef } from "vue"
import { actions as challanActions } from "../src/documents/delivery-challan/actions.js"
import { actions as receiptActions } from "../src/documents/goods-received-note/actions.js"
import { documentModule } from "../src/documents/registry.js"
import { clearReadCaches } from "../src/api/client.js"
import { completeTransfer, pendingTransferQuantity, transferArguments, transferDestination, transferItems } from "../src/documents/shared/transit.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

const challanType = "MGK Delivery Challan"
const receiptType = "MGK Goods Received Note"
const source = { doctype: challanType, name: "DC-65", docstatus: 1, is_internal_transfer: 1,
	to_location: "Unit Two", to_warehouse: "Unit Two Store", transit_warehouse: "Transit", close_status: "Open",
	items: [{ name: "row-1", item: "Yarn", qty: 10, transferred_qty: 0, returned_qty: 4, conversion_factor: 1, uom: "Kg" },
		{ name: "row-2", item: "Tee-S", qty: 5, transferred_qty: 5, uom: "Nos" }] }
const actionKeys = (doc) => challanActions(doc, () => true).map((action) => action.key)
const button = (root, label) => nodes(root, (node) => node.tag === "button" && textContent(node) === label)[0]

test("internal DC action matrix matches pending, transferred, returned and job-work states", () => {
	assert.deepEqual(actionKeys(source), ["complete-transfer", "return"])
	assert.deepEqual(actionKeys({ ...source, close_status: "" }), ["complete-transfer", "return"])
	for (const [transfer_status, transferred_qty, returned_qty] of [["Transferred", 6, 4], ["Returned", 0, 10]]) {
		assert.deepEqual(actionKeys({ ...source, transfer_status,
			items: [{ ...source.items[0], transferred_qty, returned_qty }] }), [])
	}
	assert.deepEqual(actionKeys({ ...source, is_internal_transfer: 0 }), ["return", "close", "create-grn", "update-plan"])
	for (const docstatus of [0, 2]) assert.deepEqual(actionKeys({ ...source, docstatus }), [])
	assert.deepEqual(actionKeys({ ...source, is_internal_transfer: 0, is_return: 1 }), [])
	assert.deepEqual(challanActions(source, () => false), [])
	assert.deepEqual(challanActions(source, (doctype, permission) => doctype === "YRP Stock Entry" && permission === "create").map((action) => action.key), ["complete-transfer"])
	assert.deepEqual(challanActions(source, (doctype) => doctype === challanType).map((action) => action.key), ["return"])
})

test("Complete Transfer uses the same Stock Entry create permission on DC and GRN", () => {
	for (const doctype of [challanType, receiptType]) {
		const doc = { ...source, doctype }
		const actions = documentModule(doctype).actions(doc, (target, permission) => target === "YRP Stock Entry" && permission === "create")
		assert.equal(actions[0].key, "complete-transfer")
		assert.equal(typeof actions[0].dialog, "function")
		for (const flags of [{ docstatus: 0 }, { docstatus: 2 }, { is_internal_transfer: 0 }, { items: [] }]) {
			assert.equal(documentModule(doctype).actions({ ...doc, ...flags }, () => true).some((action) => action.key === "complete-transfer"), false)
		}
	}
	assert.deepEqual(receiptActions({ ...source, doctype: receiptType }, () => false), [])
})

test("pending defaults and intro match Desk including stock-UOM returns, rounding and tolerance", () => {
	assert.equal(pendingTransferQuantity({ qty: 10, transferred_qty: 2, returned_qty: 4, conversion_factor: 2 }), 6)
	assert.equal(pendingTransferQuantity({ qty: 10, returned_qty: 4, conversion_factor: 0 }), 6)
	assert.deepEqual(transferItems(source, true).map((row) => [row.source_row, row.qty, row.pending_qty]), [["row-1", 6, 6]])
	for (const doctype of [challanType, receiptType]) {
		const { intro } = documentModule(doctype)
		assert.equal(intro({ ...source, doctype }).text, "Pending in transit: Yarn 6 Kg")
		assert.equal(intro({ ...source, items: [{ item: "Yarn", qty: 1.23456789, uom: "Kg" }] }).text, "Pending in transit: Yarn 1.234568 Kg")
		assert.equal(intro({ ...source, items: [{ qty: 0.0000001 }] }), null)
		assert.equal(intro({ ...source, docstatus: 0 }), null)
		assert.equal(intro({ ...source, is_internal_transfer: 0 }), null)
	}
})

test("destination defaults and warehouse search filters match Desk exactly", () => {
	assert.deepEqual(transferDestination(source), { warehouse: "Unit Two Store",
		filters: { supplier: "Unit Two", disabled: 0, is_group: 0, name: ["!=", "Transit"] } })
	assert.deepEqual(transferDestination({ ...source, doctype: receiptType, delivery_location: "Main", warehouse: "Main Store" }), {
		warehouse: "Main Store", filters: { supplier: "Main", disabled: 0, is_group: 0, name: ["!=", "Transit"] },
	})
})

test("transfer payload posts only source names and quantities, skips zero, rejects negative and over-pending quantities", async () => {
	const rows = transferItems(source, true)
	const args = transferArguments(source, "Receiving", rows)
	assert.deepEqual(args, { doctype: challanType, name: "DC-65", warehouse: "Receiving", items: [{ name: "row-1", qty: 6 }] })
	for (const qty of [-1, 6.000001, NaN]) assert.throws(() => transferArguments(source, "Receiving", [{ ...rows[0], qty }]), /Quantity must be positive and cannot exceed pending quantity\./)
	assert.throws(() => transferArguments(source, "Receiving", [{ ...rows[0], qty: 0 }]), /Enter a positive quantity/)
	assert.throws(() => transferArguments(source, "", rows), /Receiving Warehouse is required/)
	assert.deepEqual(transferArguments(source, "Receiving", [...rows, { source_row: "ignored", qty: 0 }]), args)
	const result = await completeTransfer(source, "Receiving", rows, async (method, payload) => {
		assert.equal(method, "mgk_yrp.stock.transit.complete_transfer")
		assert.deepEqual(payload, args)
		return "STE/10"
	})
	assert.deepEqual(result, { message: "Stock Entry submitted:", links: [{ label: "STE/10", to: "/app/yrp-stock-entry/STE%2F10" }] })
})

test("variant attributes stay attached to each persisted source row", () => {
	const doc = { ...source, __onload: { item_details: [{ attributes: ["Colour"], primary_attribute: "Size", items: [
		{ name: "Tee", attributes: { Colour: "Blue" }, values: { S: { name: "row-2" } } },
	] }] } }
	assert.deepEqual(transferItems(doc)[1].attributes, { Colour: "Blue", Size: "S" })
	assert.equal(transferItems(doc)[1].transferred_qty, 5)
})

test("Complete Transfer dialog searches destination warehouses, caps inputs, posts once and emits the Stock Entry link", async () => {
	const original = globalThis.fetch
	const requests = [], results = []
	let finish
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options })
		if (url.endsWith("complete_transfer")) await new Promise((resolve) => { finish = resolve })
		return { ok: true, status: 200, json: async () => ({ message: url.endsWith("complete_transfer") ? "STE-10" : [] }) }
	}
	const page = await mountComponent("../../src/documents/shared/CompleteTransferDialog.vue", { doc: source, onDone: (result) => results.push(result) })
	try {
		const warehouse = nodes(page.root, (node) => node.tag === "input" && node.props.role === "combobox")[0]
		assert.equal(warehouse.props.value, "Unit Two Store")
		await warehouse.props.onFocus(); await settle()
		const query = new URL(requests.find((row) => row.url.includes("search_link")).url, "http://site")
		assert.deepEqual(JSON.parse(query.searchParams.get("filters")), transferDestination(source).filters)
		const quantity = nodes(page.root, (node) => node.tag === "input" && node.props.max === 6)[0]
		assert.equal(quantity.props.value, 6)
		assert.equal(quantity.props.min, 0)
		quantity.props.onInput({ target: { value: "4" } }); await settle()
		const form = nodes(page.root, (node) => node.tag === "form")[0]
		const pending = form.props.onSubmit({ preventDefault() {} }); await settle()
		await form.props.onSubmit({ preventDefault() {} })
		assert.equal(button(page.root, "Complete Transfer").props.disabled, true)
		assert.equal(requests.filter((row) => row.url.endsWith("complete_transfer")).length, 1)
		assert.deepEqual(JSON.parse(requests.at(-1).options.body).items, [{ name: "row-1", qty: 4 }])
		finish(); await pending; await settle()
		assert.deepEqual(results[0].links, [{ label: "STE-10", to: "/app/yrp-stock-entry/STE-10" }])
		assert.equal(results[0].message, "Stock Entry submitted:")
		assert.ok(nodes(page.root, (node) => String(node.props.class).includes("table-scroll")).length)
		assert.match(textContent(page.root), /Transferred Qty/)
	} finally { finish?.(); page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("dialog preserves server errors verbatim, permits retry, and closes without a write", async () => {
	const original = globalThis.fetch
	let calls = 0, closed = 0
	globalThis.fetch = async (url) => {
		if (!url.endsWith("complete_transfer")) return { ok: true, status: 200, json: async () => ({ message: [] }) }
		calls += 1
		return { ok: false, status: 417, json: async () => ({ exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message: "Row 1: Completion exceeds the pending quantity in transit." })]) }) }
	}
	const page = await mountComponent("../../src/documents/shared/CompleteTransferDialog.vue", { doc: source, onClose: () => { closed += 1 } })
	try {
		const form = nodes(page.root, (node) => node.tag === "form")[0]
		await form.props.onSubmit({ preventDefault() {} }); await settle()
		assert.match(textContent(page.root), /Row 1: Completion exceeds the pending quantity in transit\./)
		assert.equal(button(page.root, "Complete Transfer").props.disabled, false)
		await form.props.onSubmit({ preventDefault() {} }); await settle()
		assert.equal(calls, 2)
		button(page.root, "Cancel").props.onClick()
		assert.equal(closed, 1)
		assert.equal(calls, 2)
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("shared dialog uses the existing full-screen mobile rule and keeps wide tables inside a scroll container", async () => {
	const css = await readFile(new URL("../src/documents/shared/actionDialog.css", import.meta.url), "utf8")
	assert.match(css, /max-width: 760px/)
	assert.match(css, /width: 100vw/)
	const dialog = await readFile(new URL("../src/documents/shared/ActionDialog.vue", import.meta.url), "utf8")
	const fields = await readFile(new URL("../src/document/fields/fields.css", import.meta.url), "utf8")
	assert.match(dialog, /document\/fields\/fields\.css/)
	assert.match(fields, /\.action-dialog \.link-input input/)
	assert.match(css, /\.action-dialog \.form-stack \{ display: grid; gap: 12px/)
	const page = await mountComponent("../../src/documents/shared/TransferItems.vue", { rows: transferItems(source) })
	try {
		assert.equal(nodes(page.root, (node) => node.tag === "input").length, 0)
		assert.match(textContent(page.root), /Transferred Qty/)
		assert.equal(nodes(page.root, (node) => node.tag === "tr").length, 3)
	} finally { page.close() }
})

test("document extra-action buttons disable while busy and the action host renders Stock Entry links as Desk links", async () => {
	const props = reactive({ doc: source, meta: {}, busy: false, extraActions: challanActions(source, () => true) })
	const toolbar = await mountComponent("../../src/document/DocumentActions.vue", props)
	try {
		assert.equal(button(toolbar.root, "Complete Transfer").props.disabled, false)
		props.busy = true; await settle()
		assert.equal(button(toolbar.root, "Complete Transfer").props.disabled, true)
		assert.equal(button(toolbar.root, "Return").props.disabled, true)
	} finally { toolbar.close() }
	const result = await completeTransfer(source, "Receiving", transferItems(source, true), async () => "STE-10")
	const host = await mountComponent("../../src/document/ActionHost.vue", { runner: {
		error: ref(""), result: ref(result), dialog: shallowRef(null), confirmation: ref(null),
	} })
	try {
		assert.match(textContent(host.root), /Stock Entry submitted:.*STE-10/)
		assert.equal(textContent(host.root).split("STE-10").length - 1, 1)
		assert.equal(nodes(host.root, (node) => node.tag === "a")[0].props.href, "/app/yrp-stock-entry/STE-10")
	} finally { host.close() }
})
