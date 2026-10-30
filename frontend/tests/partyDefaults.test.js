import test from "node:test"
import assert from "node:assert/strict"
import { effectScope, nextTick, ref } from "vue"
import { clearReadCaches } from "../src/api/client.js"
import { usePartyDefaults } from "../src/document/usePartyDefaults.js"

async function settle() {
	for (let index = 0; index < 4; index++) { await nextTick(); await new Promise(setImmediate) }
}

function context(response, editable = true) {
	const original = globalThis.fetch
	globalThis.fetch = async (url) => {
		const result = await response(url)
		return { ok: true, status: 200, json: async () => ({ message: result }) }
	}
	clearReadCaches()
	const scope = effectScope()
	const doc = ref(null)
	const change = (name, value) => { doc.value[name] = value }
	const model = scope.run(() => usePartyDefaults(doc, change, () => editable))
	return { doc, model, close: () => { scope.stop(); globalThis.fetch = original; clearReadCaches() } }
}

test("party defaults fill only unique candidates and expose exact candidate lists to the panel", async () => {
	const page = context(async () => ({ warehouses: ["W1"], warehouse: "W1", addresses: ["A1", "A2"], address: null, contacts: ["C1"], contact: "C1" }))
	try {
		page.doc.value = { doctype: "MGK Purchase Order", supplier: "Supplier", delivery_location: "Our location" }
		await settle()
		assert.equal(page.doc.value.warehouse, "W1")
		assert.equal(page.doc.value.contact_person, "C1")
		assert.equal(page.doc.value.supplier_address, undefined)
		assert.deepEqual(page.model.candidates.value.supplier_address, ["A1", "A2"])
		assert.deepEqual(page.model.candidates.value.warehouse, ["W1"])
		assert.ok(page.model.autoFields.value.includes("warehouse"))
		assert.equal(page.model.error.value, "")
	} finally { page.close() }
})

test("DC uses own origin and the job worker's exact warehouse candidates, fills one silently and preserves return legs", async () => {
	for (const count of [1, 2]) {
		const requests = []
		const page = context(async (url) => {
			requests.push(url)
			if (url.includes("get_own_location")) return { location: "Own", warehouse: "Own-W", warehouses: ["Own-W"] }
			const supplier = new URL(url, "http://site").searchParams.get("supplier")
			return supplier === "Own" ? { warehouse: "Own-W", warehouses: ["Own-W"] }
				: { warehouse: count === 1 ? "Worker-W1" : null, warehouses: count === 1 ? ["Worker-W1"] : ["Worker-W1", "Worker-W2"] }
		})
		try {
			page.doc.value = { doctype: "MGK Delivery Challan", __islocal: 1, to_location: "Worker" }
			await settle()
			assert.equal(page.doc.value.from_location, "Own")
			assert.equal(page.doc.value.from_warehouse, "Own-W")
			assert.equal(page.doc.value.to_warehouse, count === 1 ? "Worker-W1" : undefined)
			assert.deepEqual(page.model.candidates.value.to_warehouse, count === 1 ? ["Worker-W1"] : ["Worker-W1", "Worker-W2"])
			assert.ok(page.model.autoFields.value.includes("from_location"))
			const ownCalls = requests.filter((url) => url.includes("get_own_location")).length
			page.doc.value = { doctype: "MGK Delivery Challan", __islocal: 1, is_return: 1, from_location: "Worker", from_warehouse: "Mapped-W", to_location: "Own", to_warehouse: "Return-W" }
			await settle()
			assert.equal(page.doc.value.from_warehouse, "Mapped-W")
			assert.equal(page.doc.value.to_warehouse, "Return-W")
			assert.equal(requests.filter((url) => url.includes("get_own_location")).length, ownCalls)
		} finally { page.close() }
	}
})

test("new GRN receiving warehouse comes from own location and explicit choices are preserved", async () => {
	const page = context(async (url) => url.includes("get_own_location")
		? { location: "Own", warehouses: ["Own warehouse"], warehouse: "Own warehouse" }
		: { warehouses: ["Vendor warehouse"], warehouse: "Vendor warehouse", addresses: [], contacts: [] })
	try {
		page.doc.value = { doctype: "MGK Goods Received Note", __islocal: 1, supplier: "Vendor" }
		await settle()
		assert.equal(page.doc.value.warehouse, "Own warehouse")
		assert.deepEqual(page.model.candidates.value.warehouse, ["Own warehouse"])
		page.doc.value = { doctype: "MGK Goods Received Note", __islocal: 1, supplier: "Vendor", delivery_location: "Explicit receiving location" }
		await settle()
		assert.equal(page.doc.value.warehouse, "Vendor warehouse")
		assert.deepEqual(page.model.candidates.value.warehouse, ["Vendor warehouse"])
		page.doc.value = { doctype: "MGK Goods Received Note", supplier: "Vendor", warehouse: "Own warehouse" }
		await settle()
		assert.deepEqual(page.model.candidates.value.warehouse, ["Own warehouse"])
		page.doc.value = { doctype: "MGK Purchase Order", supplier: "Vendor", delivery_location: "Other", warehouse: "Explicit choice" }
		await settle()
		assert.equal(page.doc.value.warehouse, "Explicit choice")
	} finally { page.close() }
})

test("read-only documents are not filled and failed lookups surface errors", async () => {
	const page = context(async () => ({ warehouses: ["W1"], warehouse: "W1", addresses: [], contacts: [] }), false)
	try {
		page.doc.value = { doctype: "MGK Delivery Challan", from_location: "Own", to_location: "Vendor", is_return: 1 }
		await settle()
		assert.equal(page.doc.value.from_warehouse, undefined)
		assert.deepEqual(page.model.candidates.value.from_warehouse, ["W1"])
	} finally { page.close() }
	const broken = context(async () => { throw new Error("Not permitted") })
	try {
		broken.doc.value = { supplier: "Hidden" }
		await settle()
		assert.match(broken.model.error.value, /Not permitted/)
		assert.deepEqual(broken.model.candidates.value.warehouse, [])
	} finally { broken.close() }
})

test("submitted and cancelled documents skip defaults, including retry and an in-flight draft lookup", async () => {
	const requests = []
	let resolve
	const page = context(async (url) => {
		requests.push(url)
		return new Promise((done) => { resolve = done })
	})
	try {
		for (const docstatus of [1, 2]) {
			page.doc.value = { doctype: "MGK Purchase Order", docstatus, supplier: "Vendor" }
			await settle()
			await page.model.retry()
		}
		assert.equal(requests.length, 0)
		page.doc.value = { doctype: "MGK Purchase Order", docstatus: 0, supplier: "Vendor" }
		await settle()
		assert.equal(requests.length, 1)
		page.doc.value.docstatus = 1
		await settle()
		resolve({ warehouses: [], addresses: ["A1"], address: "A1", contacts: [] })
		await settle()
		assert.equal(page.doc.value.supplier_address, undefined)
		assert.equal(page.model.loading.value, false)
		assert.deepEqual(page.model.candidates.value.supplier_address, [])
	} finally { resolve?.({}); page.close() }
})
