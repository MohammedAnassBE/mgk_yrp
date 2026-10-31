import test from "node:test"
import assert from "node:assert/strict"
import { callMethod, clearReadCaches } from "../src/api/client.js"
import { runAction } from "../src/document/actionRunner.js"
import { lifecycleActions } from "../src/document/lifecycleActions.js"
import { previewActions } from "../src/list/previewActions.js"

const can = () => true
const receipt = { doctype: "MGK Goods Received Note", name: "GRN-1", docstatus: 1 }
const close = { doctype: "MGK Delivery Challan Close", name: "Close-1", delivery_challan: "DC-1", docstatus: 1 }
const labels = (doc, allowed = can, meta = { is_submittable: 1 }) => previewActions(doc, meta, allowed).map((action) => action.label)

test("preview menu orders lifecycle and module actions by state and excludes links", () => {
	assert.deepEqual(labels({ ...receipt, docstatus: 0 }), ["Submit"])
	assert.deepEqual(labels(receipt), ["Create DC", "Cancel"])
	assert.deepEqual(labels(receipt, (_doctype, permission) => permission !== "cancel"), ["Create DC"])
	assert.deepEqual(labels(receipt, (_doctype, permission) => permission !== "create"), ["Cancel"])
	assert.deepEqual(labels(close), ["Reopen"])
	assert.deepEqual(labels({ ...close, docstatus: 2, reopen_status: "Reversing" }), ["Finish Reopen"])
	assert.deepEqual(labels({ ...receipt, docstatus: 2 }), [])
	assert.deepEqual(labels({ ...receipt, docstatus: 0 }, can, { is_submittable: 0 }), [])
	const challan = { doctype: "MGK Delivery Challan", docstatus: 1, close_status: "Open", delivery_challan_close: "Close-1" }
	assert.deepEqual(labels(challan), ["Return", "Close", "Create GRN", "Update Plan", "Cancel"])
	assert.deepEqual(labels({ ...challan, close_status: "Closed" }), ["Cancel"])
	const order = { doctype: "MGK Purchase Order", docstatus: 1, items: [{ pending_qty: 1 }] }
	assert.deepEqual(labels(order), ["Create GRN", "Mark as Received", "Cancel"])
	assert.deepEqual(labels({ doctype: "MGK Purchase Invoice", docstatus: 1 }), ["Cancel"])
	for (const doc of [receipt, close, challan, order, { ...receipt, docstatus: 0 }]) assert.deepEqual(labels(doc, () => false), [])
})

test("lifecycle confirmations match the document page, including DC reopening", () => {
	assert.equal(lifecycleActions({ ...receipt, docstatus: 0 }, { is_submittable: 1 }, can)[0].confirm, "Confirm submit for GRN-1?")
	assert.equal(lifecycleActions(receipt, {}, can)[0].confirm, "Confirm cancel for GRN-1?")
	assert.equal(lifecycleActions(close, {}, can)[0].confirm,
		"Reopen Delivery Challan DC-1? Its valuation will be reversed before stock is released.")
})

test("submit fetches the latest saved document and sends it to frappe.client.submit", async () => {
	const original = globalThis.fetch
	const requests = []
	const latest = { ...receipt, docstatus: 0, modified: "latest", items: [{ qty: 17 }] }
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options })
		return { ok: true, status: 200, json: async () => url.includes("getdoc") ? { docs: [latest] } : { message: { ...latest, docstatus: 1 } } }
	}
	try {
		const action = lifecycleActions({ ...receipt, docstatus: 0 }, { is_submittable: 1 }, can)[0]
		let result
		await runAction(action, { doc: { ...receipt, docstatus: 0 } }, {
			call: callMethod, confirm: async () => true, finished: async (value) => { result = value },
		})
		assert.match(requests[0].url, /frappe.desk.form.load.getdoc.*doctype=MGK\+Goods\+Received\+Note.*name=GRN-1/)
		assert.equal(requests[1].url, "/api/method/frappe.client.submit")
		assert.deepEqual(JSON.parse(requests[1].options.body), { doc: latest })
		assert.equal(result.message, "GRN-1 submitted.")
	} finally { globalThis.fetch = original; clearReadCaches() }
})

test("cancel and reopen use the existing server method and return their completion messages", async () => {
	for (const [doc, message] of [[receipt, "GRN-1 cancelled."], [close, "DC-1 reopening started."]]) {
		const action = lifecycleActions(doc, {}, can)[0]
		const result = await action.run({ doc }, { call: async (method, args) => {
			assert.equal(method, "frappe.client.cancel")
			assert.deepEqual(args, { doctype: doc.doctype, name: doc.name })
			return { ...doc, docstatus: 2 }
		} })
		assert.equal(result.message, message)
	}
})

test("rejected confirmation does not mutate or finish an action", async () => {
	const action = lifecycleActions(receipt, {}, can)[0]
	await runAction(action, { doc: receipt }, { confirm: async () => false,
		call: () => assert.fail("Mutation after rejection"), finished: () => assert.fail("Refresh after rejection") })
})

test("a selection change during the submit read prevents submitting the old document", async () => {
	const original = globalThis.fetch
	let finish
	globalThis.fetch = () => new Promise((resolve) => { finish = () => resolve({ ok: true, status: 200,
		json: async () => ({ docs: [receipt] }) }) })
	try {
		const action = lifecycleActions({ ...receipt, docstatus: 0 }, { is_submittable: 1 }, can)[0]
		const pending = action.run({ doc: receipt }, { call: () => assert.fail("Submitted an abandoned document"), isCurrent: () => false })
		finish()
		assert.equal(await pending, undefined)
	} finally { globalThis.fetch = original; clearReadCaches() }
})
