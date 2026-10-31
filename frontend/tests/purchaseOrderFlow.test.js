import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createApp, effectScope, nextTick, ref } from "vue"
import { routerKey } from "vue-router"
import { callMethod, clearReadCaches } from "../src/api/client.js"
import { bookRegistry } from "../src/books/registry.js"
import { fieldState } from "../src/document/fieldConditions.js"
import { fieldQuery } from "../src/document/fieldQueries.js"
import { documentLayout } from "../src/document/documentLayout.js"
import { useActionRunner } from "../src/document/useActionRunner.js"
import { usePartyDefaults } from "../src/document/usePartyDefaults.js"
import { documentModule } from "../src/documents/registry.js"
import { actions } from "../src/documents/purchase-order/actions.js"
import { createFieldEvents, purchaseOrderChanges } from "../src/documents/purchase-order/fieldEvents.js"
import { connections } from "../src/documents/purchase-order/presentation.js"
import { routeFilters } from "../src/list/routeFilters.js"

const order = { name: "PO-1", doctype: "MGK Purchase Order", docstatus: 1, delivery_location: "Unit Two", items: [{ pending_qty: 2 }] }
const allow = () => true
const receiveAction = (doc = order) => actions(doc, allow).find((action) => action.key === "mark-as-received")

function deferred() {
	let resolve, reject
	const promise = new Promise((done, fail) => { resolve = done; reject = fail })
	return { promise, resolve, reject }
}

function mockFetch(t, handler) {
	const original = globalThis.fetch
	clearReadCaches()
	globalThis.fetch = handler
	t.after(() => { globalThis.fetch = original; clearReadCaches() })
}

function response(message) {
	return { ok: true, status: 200, json: async () => ({ message }) }
}

async function settle() {
	for (let index = 0; index < 4; index++) { await nextTick(); await new Promise(setImmediate) }
}

test("W14 PO panel uses the real Process metadata: optional when off, mandatory when ticked", async () => {
	const meta = JSON.parse(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_purchase_order/mgk_purchase_order.json", import.meta.url)))
	const panel = documentLayout(order.doctype, meta).panel
	assert.ok(panel.some((field) => field.fieldname === "deliver_to_supplier"))
	const process = panel.find((field) => field.fieldname === "process_name")
	assert.equal(process.mandatory_depends_on, "eval:doc.deliver_to_supplier")
	assert.equal(process.depends_on, undefined)
	for (const deliver_to_supplier of [0, 1]) {
		const state = fieldState(process, { deliver_to_supplier }, meta, { name: "Administrator" })
		assert.equal(state.visible, true)
		assert.equal(state.required, Boolean(deliver_to_supplier))
	}
	assert.ok(documentModule(order.doctype).asyncFields.includes("deliver_to_supplier"))
})

test("G3/G4 PO supplier, destination and warehouse use Desk filters without changing other pickers", () => {
	const supplier = { fieldname: "supplier", options: "Supplier" }
	assert.deepEqual(fieldQuery(supplier, order), { filters: { disabled: 0, is_company_location: 0 } })
	for (const deliver_to_supplier of [0, 1]) {
		assert.deepEqual(fieldQuery({ fieldname: "delivery_location", options: "Supplier" }, { ...order, deliver_to_supplier }),
			{ filters: { disabled: 0, is_company_location: deliver_to_supplier ? 0 : 1 } })
	}
	assert.deepEqual(fieldQuery({ fieldname: "handling_supplier", options: "Supplier" }, order), { filters: { disabled: 0 } })
	assert.deepEqual(fieldQuery(supplier, { doctype: "MGK Goods Received Note" }), { filters: { disabled: 0 } })
	for (const delivery_location of ["Unit Two", ""]) {
		assert.deepEqual(fieldQuery({ fieldname: "warehouse", options: "Warehouse" }, { ...order, delivery_location }),
			{ filters: { supplier: delivery_location, disabled: 0, is_group: 0 } })
	}
})

test("W14 ticking clears destination and warehouse while retaining Process", async () => {
	const doc = { deliver_to_supplier: 1, delivery_location: "Own", warehouse: "Own-W", process_name: "Doubling" }
	assert.deepEqual(purchaseOrderChanges("deliver_to_supplier", doc), { delivery_location: "", warehouse: "" })
	await createFieldEvents({ getDoc: () => doc, call: () => assert.fail("Tick must not request defaults") }).change("deliver_to_supplier")
	assert.equal(doc.delivery_location, "")
	assert.equal(doc.warehouse, "")
	assert.equal(doc.process_name, "Doubling")
})

test("W14 unticking validates the destination and refills only server-selected defaults (R56)", async () => {
	for (const warehouses of [[], ["Own-W"], ["Own-W1", "Own-W2"]]) {
		const doc = { deliver_to_supplier: 0, delivery_location: "Worker", warehouse: "Worker-W" }
		const candidates = {}, automatic = [], calls = []
		const events = createFieldEvents({ getDoc: () => doc, setCandidates: (field, values) => { candidates[field] = values },
			markAuto: (fields) => automatic.push(...fields), call: async (method, args) => {
				calls.push({ method, args })
				if (method === "frappe.client.get_value") return { is_company_location: 0, disabled: 0 }
				assert.equal(method, "mgk_yrp.party_defaults.get_own_location")
				return { location: "Own", warehouses, warehouse: warehouses.length === 1 ? warehouses[0] : null }
			} })
		await events.change("deliver_to_supplier")
		assert.deepEqual(calls[0].args, { doctype: "Supplier", filters: { name: "Worker" }, fieldname: ["is_company_location", "disabled"] })
		assert.equal(doc.delivery_location, "Own")
		assert.equal(doc.warehouse, warehouses.length === 1 ? warehouses[0] : "")
		assert.deepEqual(candidates.warehouse, warehouses)
		assert.deepEqual(automatic, warehouses.length === 1 ? ["delivery_location", "warehouse"] : ["delivery_location"])
	}
})

test("W14 unticking preserves valid company locations, replaces disabled ones and leaves absent defaults empty", async () => {
	for (const disabled of [0, 1]) {
		const doc = { deliver_to_supplier: 0, delivery_location: "Own", warehouse: "Chosen" }
		const events = createFieldEvents({ getDoc: () => doc, call: async (method) => {
			if (method === "frappe.client.get_value") return { is_company_location: 1, disabled }
			assert.equal(disabled, 1)
			return { location: null, warehouse: null, warehouses: [] }
		} })
		await events.change("deliver_to_supplier")
		assert.equal(doc.delivery_location, disabled ? "" : "Own")
		assert.equal(doc.warehouse, disabled ? "" : "Chosen")
	}
})

test("W14 stale refill cannot overwrite a new toggle, destination or document, including A-B-A", async () => {
	for (const invalidate of ["toggle", "destination", "document", "A-B-A"]) {
		let doc = { deliver_to_supplier: 0, delivery_location: "", warehouse: "" }
		const requests = []
		const events = createFieldEvents({ getDoc: () => doc, call: () => {
			const pending = deferred(); requests.push(pending); return pending.promise
		} })
		const first = events.change("deliver_to_supplier")
		if (["toggle", "A-B-A"].includes(invalidate)) { doc.deliver_to_supplier = 1; await events.change("deliver_to_supplier") }
		if (invalidate === "destination") { doc.delivery_location = "Chosen"; await events.change("delivery_location") }
		if (invalidate === "document") doc = { ...doc }
		if (invalidate === "A-B-A") {
			doc.deliver_to_supplier = 0
			const latest = events.change("deliver_to_supplier")
			requests[1].resolve({ location: "Latest", warehouse: "Latest-W", warehouses: ["Latest-W"] })
			await latest
		}
		requests[0].resolve({ location: "Obsolete", warehouse: "Obsolete-W", warehouses: ["Obsolete-W"] })
		await first
		assert.notEqual(doc.delivery_location, "Obsolete", invalidate)
		assert.notEqual(doc.warehouse, "Obsolete-W", invalidate)
	}
	const doc = { deliver_to_supplier: 0 }
	const events = createFieldEvents({ getDoc: () => doc, call: async () => { throw new Error("Permission denied") } })
	await assert.rejects(events.change("deliver_to_supplier"), { message: "Permission denied" })
})

test("W14 shared party defaults never restore company location on a ticked PO and retain exact warehouse candidates", async (t) => {
	mockFetch(t, async (url) => {
		assert.ok(!url.includes("get_own_location"))
		return response({ warehouse: null, warehouses: ["Worker-W1", "Worker-W2"], addresses: [], contacts: [] })
	})
	const scope = effectScope(), doc = ref(null)
	t.after(() => scope.stop())
	const party = scope.run(() => usePartyDefaults(doc, (field, value) => { doc.value[field] = value }, () => true))
	doc.value = { doctype: order.doctype, __islocal: 1, deliver_to_supplier: 1, delivery_location: "", warehouse: "" }
	await settle()
	assert.equal(doc.value.delivery_location, "")
	assert.equal(doc.value.warehouse, "")
	doc.value.delivery_location = "Worker"
	await settle()
	assert.equal(doc.value.warehouse, "")
	assert.deepEqual(party.candidates.value.warehouse, ["Worker-W1", "Worker-W2"])
	assert.equal(party.error.value, "")
})

test("W15 action visibility matches Desk submission, pending rows and both create permissions", () => {
	for (const docstatus of [0, 1, 2]) for (const pending_qty of [-1, 0, 2]) {
		for (const deliver_to_supplier of [0, 1]) for (const canCreateReceipt of [false, true]) for (const canCreateChallan of [false, true]) {
			const doc = { ...order, docstatus, deliver_to_supplier, items: [{ pending_qty }] }
			const result = actions(doc, (doctype, permission) => ["create", "submit"].includes(permission)
				&& (doctype === "MGK Goods Received Note" ? canCreateReceipt : canCreateChallan))
			const isAvailable = docstatus === 1 && pending_qty > 0 && canCreateReceipt
			assert.equal(result.some((action) => action.key === "create-grn"), isAvailable)
			assert.equal(result.some((action) => action.key === "mark-as-received"), isAvailable && (!deliver_to_supplier || canCreateChallan))
		}
	}
	assert.equal(actions({ ...order, items: [] }, allow).length, 0)
	assert.equal(actions({ ...order, items: [{ pending_qty: 0 }, { pending_qty: "1" }] }, allow).length, 2)
})

test("W15 uses the verbatim Desk confirmations and exact RPC signature, returning GRN and optional DC links", async () => {
	const action = receiveAction()
	assert.equal(action.confirm(order), "Create and submit a GRN for the full pending quantity at Unit Two?")
	assert.equal(action.confirm({ ...order, deliver_to_supplier: 1, delivery_location: "Knit Works", process_name: "Doubling" }),
		"Create and submit a GRN for the full pending quantity at Head Office, then a Delivery Challan from Head Office to Knit Works for process Doubling?")
	for (const delivery_challan of [null, "DC / 1"]) {
		const result = await action.run({ doc: order }, { call: async (method, args) => {
			assert.equal(method, "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.mark_as_received")
			assert.deepEqual(args, { source_name: "PO-1" })
			return { goods_received_note: "GRN / 1", delivery_challan }
		} })
		assert.deepEqual(result.links, [{ label: "GRN / 1", to: "/goods-received-note/GRN%20%2F%201" },
			...(delivery_challan ? [{ label: delivery_challan, to: "/delivery-challan/DC%20%2F%201" }] : [])])
		assert.equal(result.message, "Created and submitted:")
	}
})

test("W15 action runner rejects duplicate clicks during confirmation, RPC and reload", async (t) => {
	const pending = deferred(), reloaded = deferred()
	let calls = 0, reloads = 0
	mockFetch(t, async () => { calls += 1; return response(await pending.promise) })
	const app = createApp({})
	app.provide(routerKey, { push: () => assert.fail("Receive must stay on the PO") })
	const scope = effectScope()
	t.after(() => scope.stop())
	const runner = scope.run(() => app.runWithContext(() => useActionRunner({ reload: async () => { reloads += 1; await reloaded.promise } })))
	const action = receiveAction(), target = { doc: order }
	const first = runner.run(action, target)
	assert.equal(runner.busy.value, true)
	await runner.run(action, target)
	assert.equal(calls, 0)
	runner.answer(true)
	await settle()
	assert.equal(calls, 1)
	await runner.run(action, target)
	assert.equal(calls, 1)
	pending.resolve({ goods_received_note: "GRN-1", delivery_challan: "DC-1" })
	await settle()
	assert.equal(reloads, 1)
	assert.equal(runner.busy.value, true)
	await runner.run(action, target)
	assert.equal(calls, 1)
	reloaded.resolve()
	await first
	assert.equal(runner.busy.value, false)
	assert.equal(runner.result.value.links.length, 2)
	const cancelled = runner.run(action, target)
	runner.answer(false)
	await cancelled
	assert.equal(calls, 1)
})

test("G4 company-location supplier rejection passes through the API verbatim", async (t) => {
	const message = "Unit Two is a company location; use a Delivery Challan to move stock between company locations."
	mockFetch(t, async () => ({ ok: false, status: 417, json: async () => ({ exc_type: "ValidationError",
		_server_messages: JSON.stringify([JSON.stringify({ message })]) }) }))
	await assert.rejects(callMethod("frappe.client.save", { doc: { ...order, supplier: "Unit Two" } }), { message })
})

test("W16/G6 PO connections and destination lists share purchase_order and cancellation filters", () => {
	assert.deepEqual(bookRegistry["mgk-purchase-order"].relatedDoctypes, ["MGK Goods Received Note", "MGK Delivery Challan"])
	assert.deepEqual(connections({ __islocal: 1, name: "new" }), [])
	assert.deepEqual(connections({}), [])
	const result = connections({ name: "PO / 1" })
	assert.deepEqual(result.map((connection) => connection.doctype), ["MGK Goods Received Note", "MGK Delivery Challan"])
	assert.equal(result[1].to.path, "/delivery-challan")
	for (const connection of result) {
		assert.deepEqual(connection.filters, [["purchase_order", "=", "PO / 1"], ["docstatus", "<", 2]])
		assert.deepEqual(routeFilters(connection.doctype, connection.to.query), connection.filters)
	}
})
