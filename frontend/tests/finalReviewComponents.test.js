import test from "node:test"
import assert from "node:assert/strict"
import { createRouter, createMemoryHistory } from "vue-router"
import { clearReadCaches } from "../src/api/client.js"
import { realtime } from "../src/realtime/socket.js"
import { getMaster } from "../src/masters/mastersConfig.js"
import billing from "../src/books/billing/config.js"
import handlers from "../../realtime/handlers.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

function environment(doctypes = []) {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	const socket = new FakeSocket()
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: doctypes } } }, addEventListener() {}, removeEventListener() {} }
	Object.assign(realtime, { socket: null, pending: null, rooms: new Map(), connectedBefore: false,
		reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => socket })
	return { socket, restore() { globalThis.window = original.window; globalThis.fetch = original.fetch; Object.assign(realtime, original.realtime); clearReadCaches() } }
}

test("document and master load denials retain the requested name in breadcrumbs", async () => {
	for (const master of [null, getMaster("warehouses")]) {
		const doctype = master?.doctype || billing.doctype
		const context = environment([doctype])
		globalThis.fetch = async (url) => url.includes("getdoctype")
			? { ok: true, status: 200, json: async () => ({ docs: [{ name: doctype, fields: [] }] }) }
			: { ok: false, status: 403, json: async () => ({ exc_type: "PermissionError", message: "No access to this document" }) }
		const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:name", component: { render: () => null } }, { path: "/:pathMatch(.*)*", component: { render: () => null } }] })
		await router.push("/REQUESTED-403")
		const page = await mountComponent(master ? "../../src/masters/MasterEntry.vue" : "../../src/document/DocumentPage.vue",
			master ? { master } : { book: billing }, [router])
		try {
			await settle()
			const breadcrumb = nodes(page.root, (node) => node.tag === "nav")[0]
			assert.match(textContent(breadcrumb), /REQUESTED-403/)
			assert.doesNotMatch(textContent(breadcrumb), /New entry/)
			assert.match(textContent(page.root), /No access to this document/)
		} finally { page.close(); context.restore() }
	}
})

test("link inputs show Company names unless metadata explicitly enables titles, preserving stored values", async () => {
	for (const component of ["../../src/document/fields/LinkField.vue", "../../src/list/LinkInput.vue"]) {
		for (const enabled of [undefined, 0, 1, "1"]) {
			const context = environment()
			const requests = [], changes = []
			globalThis.fetch = async (url) => {
				requests.push(url)
				return { ok: true, status: 200, json: async () => url.includes("getdoctype")
					? { docs: [{ name: "Company", title_field: "company_name", show_title_field_in_link: enabled }] }
					: { message: { company_name: "Essdee" } } }
			}
			const page = await mountComponent(component, { doctype: "Company", modelValue: "Essdee India", "onUpdate:modelValue": (value) => changes.push(value) })
			try {
				await settle()
				assert.equal(nodes(page.root, (node) => node.tag === "input")[0].props.value, Number(enabled) === 1 ? "Essdee" : "Essdee India")
				assert.equal(requests.some((url) => url.includes("frappe.client.get_value")), Number(enabled) === 1)
				assert.deepEqual(changes, [])
			} finally { page.close(); context.restore() }
		}
	}
})

test("an open Stock page refetches after valuation adjustment and reversal completion", async () => {
	const context = environment(["YRP Stock Ledger Entry", "Warehouse"])
	let value = 40, reads = 0
	globalThis.fetch = async () => {
		reads++
		const snapshot = value
		return { ok: true, status: 200, json: async () => ({ message: {
			rows: [], summary: { line_count: 0, warehouse_count: 0, total_value: snapshot, uom_totals: {} },
			options: { suppliers: [], warehouses: [], items: [], received_types: [] },
		} }) }
	}
	const page = await mountComponent("../../src/books/stock/StockListPage.vue", {})
	try {
		assert.ok(context.socket.emitted.some((args) => args[0] === "doctype_subscribe" && args[1] === "YRP Stock Ledger Entry"))
		for (const amount of [100, 40]) {
			value = amount
			context.socket.fire("list_update", { doctype: "YRP Stock Ledger Entry" })
			await new Promise((resolve) => setTimeout(resolve, 550)); await settle()
			assert.match(textContent(page.root), new RegExp(`Stock value${amount}\\.00`))
		}
		assert.equal(reads, 3)
	} finally { page.close(); context.restore() }
})

test("MGK document-room acknowledgement follows authorization and completed membership", async () => {
	const socket = new FakeSocket()
	let permit, join, acknowledged = false
	socket.connected = true
	socket.has_permission = (doctype, name) => {
		assert.deepEqual([doctype, name], ["MGK Purchase Order", "PO-1"])
		return new Promise((resolve) => { permit = resolve })
	}
	socket.join = (room) => {
		assert.equal(room, "doc:MGK Purchase Order/PO-1")
		return new Promise((resolve) => { join = resolve })
	}
	handlers(socket)
	const subscribe = [...socket.handlers.get("mgk_doc_subscribe")][0]
	const pending = subscribe("MGK Purchase Order", "PO-1", () => { acknowledged = true })
	assert.equal(join, undefined)
	assert.equal(acknowledged, false)
	permit(); await settle()
	assert.equal(acknowledged, false)
	join(); await pending
	assert.equal(acknowledged, true)
})
