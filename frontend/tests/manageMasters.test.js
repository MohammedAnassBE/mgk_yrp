import test from "node:test"
import assert from "node:assert/strict"
import { masters } from "../src/masters/mastersConfig.js"
import { clearReadCaches } from "../src/api/client.js"
import { realtime } from "../src/realtime/socket.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, textContent } from "./helpers/component.js"

test("every Manage card shows a coloured + New to its new form only with create permission", async () => {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	Object.assign(realtime, { socket: null, pending: null, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	const doctypes = masters.map((master) => master.doctype)
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ message: doctypes.map(() => 0) }) })
	const newLinks = (page) => nodes(page.root, (node) => node.tag === "a" && textContent(node) === "+ New")
	try {
		globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: doctypes, can_create: doctypes } } } }
		let page = await mountComponent("../../src/books/masters/MastersListPage.vue", {})
		try {
			assert.deepEqual(newLinks(page).map((node) => node.props.href), masters.map((master) => `${master.route}/new`))
			assert.ok(newLinks(page).every((node) => node.props.class.includes("button") && node.props.class.includes("manage-create") && node.props.class.includes("cover-masters")))
		} finally { page.close() }
		globalThis.window = { frappe: { boot: { user: { name: "Reader", can_read: doctypes, can_create: ["Warehouse"] } } } }
		page = await mountComponent("../../src/books/masters/MastersListPage.vue", {})
		try { assert.deepEqual(newLinks(page).map((node) => node.props.href), ["/manage/warehouses/new"]) }
		finally { page.close() }
	} finally { globalThis.window = original.window; globalThis.fetch = original.fetch; Object.assign(realtime, original.realtime); clearReadCaches() }
})
