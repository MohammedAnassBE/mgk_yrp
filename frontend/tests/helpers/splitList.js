import { reactive } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { realtime } from "../../src/realtime/socket.js"
import { clearReadCaches } from "../../src/api/client.js"
import { FakeSocket } from "./fakeSocket.js"
import { mountComponent, nodes, settle, textContent } from "./component.js"

export const records = () => ["A", "B", "C"].map((name) => ({ name, supplier: `Supplier ${name}`, po_date: "2026-10-30", total_qty: 10, total_amount: 50, docstatus: 1, modified: "one" }))

export async function mountSplit({ phone = false, selected = "", rows = records(), doctype = "MGK Purchase Order", preview = {}, user = {}, respond } = {}) {
	const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, realtime: { ...realtime } }
	const scrolls = []
	const listeners = {}
	const socket = new FakeSocket()
	globalThis.document = { querySelector: (selector) => selector === ".ops-topbar" ? { getBoundingClientRect: () => ({ height: 58 }) } : null }
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: [doctype], ...user } } },
		matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
		addEventListener: (name, handler) => { listeners[name] = handler }, removeEventListener: (name) => { delete listeners[name] },
		scrollY: 640, scrollTo: (position) => scrolls.push(position.top), sessionStorage: { getItem: () => null, setItem() {} } }
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(),
		reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => socket })
	const requests = []
	globalThis.fetch = async (url, options) => {
		requests.push(url)
		const name = new URL(url, "http://site").searchParams.get("name")
		const message = { items: [], connections: [], timeline: [], extra: {}, ...preview,
			doc: { ...rows.find((row) => row.name === name), name, ...preview.doc } }
		const result = respond ? await respond(url, options, message) : message
		return { ok: true, status: 200, json: async () => result?.docs ? result : { message: result } }
	}
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] })
	await router.push({ path: "/purchase-order", query: selected ? { selected } : {} })
	const props = reactive({ doctype, rows,
		columns: [{ fieldname: "name" }, { fieldname: "po_date", label: "Date" }, { fieldname: "warehouse", label: "Warehouse" }],
		selected: "", total: rows.length, loadMore: async () => {}, documentRoute: (name) => `/purchase-order/${name}`,
		displayValue: (row, column) => row[column.fieldname] || "—", queryKey: "one", bulkActions: [],
		savePosition() {}, refresh: async () => {}, "onUpdate:selected": (name) => { props.selected = name } })
	const page = await mountComponent("../../src/list/SplitListView.vue", props, [router])
	nodes(page.root, (node) => node.props.class === "split-preview")[0].getBoundingClientRect = () => ({ top: 420 })
	await settle()
	return { ...page, props, router, requests, socket, scrolls, listeners, close() {
		page.close(); Object.assign(realtime, original.realtime); globalThis.window = original.window; globalThis.document = original.document; globalThis.fetch = original.fetch; clearReadCaches()
	} }
}

export const options = (page) => nodes(page.root, (node) => node.props.role === "option")
export const button = (page, label) => nodes(page.root, (node) => node.tag === "button" && textContent(node) === label)[0]
export async function runMenuAction(page, label) {
	button(page, "Actions").props.onClick({})
	await settle()
	return button(page, label).props.onClick()
}
