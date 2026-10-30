import test from "node:test"
import assert from "node:assert/strict"
import { createRenderer, nextTick } from "vue"
import { createRouter, createMemoryHistory } from "vue-router"
import { clearReadCaches } from "../src/api/client.js"
import { useListView } from "../src/list/useListView.js"
import { listStateKey, readNewDefaults, saveListState } from "../src/list/listState.js"
import { realtime } from "../src/realtime/socket.js"
import purchaseOrder from "../src/books/purchase-order/config.js"
import goodsReceivedNote from "../src/books/goods-received-note/config.js"
import { FakeSocket } from "./helpers/fakeSocket.js"

const renderer = createRenderer({
	createComment: (text) => ({ text }), createText: (text) => ({ text }),
	insert: () => {}, remove: () => {}, setText: () => {}, parentNode: () => null, nextSibling: () => null,
})
const meta = { name: purchaseOrder.doctype, fields: [
	{ fieldname: "supplier", label: "Supplier", fieldtype: "Link", options: "Supplier", in_standard_filter: 1 },
	{ fieldname: "po_date", label: "PO Date", fieldtype: "Date", in_standard_filter: 1 },
	{ fieldname: "status", label: "Status", fieldtype: "Select", read_only: 1 },
	{ fieldname: "is_karigan_order", label: "Karigan", fieldtype: "Check" },
] }

async function settle() { await nextTick(); await new Promise(setImmediate); await nextTick() }

async function mountList({ saved, canCreate = true, tab = "all", book = purchaseOrder, query = {} } = {}) {
	const originals = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	const values = new Map()
	const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }
	const socket = new FakeSocket()
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => socket })
	const requests = []
	let model
	globalThis.window = {
		frappe: { boot: { user: { name: "list@example.test", can_read: [book.doctype, "MGK Goods Received Note"], can_create: canCreate ? [book.doctype] : [] } } },
		sessionStorage: storage, scrollY: 0, csrf_token: "csrf",
		scrollTo: ({ top }) => { assert.equal(model.initializing.value, false); window.scrollY = top },
	}
	globalThis.fetch = async (url, options) => {
		requests.push([url, options])
		let body
		if (url.includes("getdoctype")) body = { docs: [{ ...meta, name: book.doctype }] }
		else if (url.includes("get_user_listview")) body = { message: null }
		else if (url.includes("get_counts")) body = { message: [90, 90, 35, 40] }
		else {
			const params = new URL(url, "http://site").searchParams
			const start = Number(params.get("limit_start"))
			body = { data: Array.from({ length: Number(params.get("limit")) }, (_, index) => ({ name: `PO-${start + index + 1}` })) }
		}
		return { status: 200, ok: true, json: async () => body }
	}
	clearReadCaches()
	if (saved) saveListState(listStateKey(book.doctype, book.routePath), saved, storage)
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] })
	await router.push({ path: book.routePath, query: { tab, ...query } })
	const app = renderer.createApp({ setup() {
		model = useListView({ ...book, baseFilters: [], defaultOrderBy: "modified desc", createRoute: `${book.routePath}/new`, documentRoute: book.routePath, statusLabel: "Status" })
		return () => null
	} })
	app.use(router).mount({})
	await settle()
	return {
		model, socket, router, storage, requests,
		rows: () => requests.filter(([url]) => url.startsWith("/api/resource/")),
		counts: () => requests.filter(([url]) => url.includes("get_counts")),
		close: () => { app.unmount(); Object.assign(realtime, originals.realtime); globalThis.window = originals.window; globalThis.fetch = originals.fetch; clearReadCaches() },
	}
}

test("list initialization waits for meta/preferences before its one rows/count batch", async () => {
	const list = await mountList()
	try {
		assert.equal(list.requests.length, 4)
		assert.match(list.requests[0][0], /getdoctype/)
		assert.match(list.requests[1][0], /get_user_listview/)
		assert.equal(list.model.data.rows.length, 20)
		assert.equal(list.model.data.total, 90)
		assert.deepEqual(list.socket.emitted, [["doctype_subscribe", "MGK Purchase Order"], ["doctype_subscribe", "MGK Goods Received Note"]])
	} finally { list.close() }
})

test("a PO connection URL overrides an old GRN list state and Clear removes the URL filter", async () => {
	const list = await mountList({ book: goodsReceivedNote, query: { purchase_order: "PO / 1" },
		saved: { filters: [["supplier", "=", "Old supplier"]], search: "Old GRN", tab: "job-work", quickFilters: { supplier: "Old supplier" } } })
	try {
		const filters = [["purchase_order", "=", "PO / 1"], ["docstatus", "<", 2]]
		assert.deepEqual(list.model.query.filters, filters)
		assert.equal(list.model.query.tab, "all")
		assert.equal(list.model.search.value, "")
		assert.deepEqual(JSON.parse(new URL(list.rows()[0][0], "http://site").searchParams.get("filters")), filters)
		list.model.clearFilters()
		await settle(); await settle()
		assert.equal(list.router.currentRoute.value.query.purchase_order, undefined)
		assert.deepEqual(list.model.query.filters, [])
	} finally { list.close() }
})

test("Sort by retains the chosen direction while header clicks still toggle it", async () => {
	const list = await mountList()
	try {
		list.model.direction(); await settle()
		assert.equal(list.model.query.sortDirection, "asc")
		list.model.sort("creation"); await settle()
		assert.equal(list.model.query.sortDirection, "asc")
		list.model.sort("creation", true); await settle()
		assert.equal(list.model.query.sortDirection, "desc")
	} finally { list.close() }
})

test("search debounces 300ms and Enter immediately applies the latest ID query", async (t) => {
	const list = await mountList()
	t.mock.timers.enable({ apis: ["setTimeout"] })
	try {
		list.model.searchChanged("PO-1")
		t.mock.timers.tick(299); await settle()
		assert.equal(list.rows().length, 1)
		t.mock.timers.tick(1); await settle()
		assert.equal(list.rows().length, 2)
		assert.deepEqual(JSON.parse(new URL(list.rows().at(-1)[0], "http://site").searchParams.get("filters")), [["name", "like", "%PO-1%"]])
		list.model.searchChanged("PO-2"); list.model.applySearch(); await settle()
		assert.equal(list.rows().length, 3)
		t.mock.timers.tick(300); await settle()
		assert.equal(list.rows().length, 3)
	} finally { list.close() }
})

test("quick filters apply after 1000ms, use Date equals for rows/counts, and Clear removes all active tuples", async (t) => {
	const list = await mountList()
	t.mock.timers.enable({ apis: ["setTimeout"] })
	try {
		list.model.quickChanged({ po_date: "2026-10-29" })
		t.mock.timers.tick(999); await settle()
		assert.equal(list.rows().length, 1)
		t.mock.timers.tick(1); await settle()
		assert.equal(list.model.filterCount.value, 1)
		assert.deepEqual(JSON.parse(new URL(list.rows().at(-1)[0], "http://site").searchParams.get("filters")), [["po_date", "=", "2026-10-29"]])
		const counts = JSON.parse(new URL(list.counts().at(-1)[0], "http://site").searchParams.get("doctype_filter_sets"))
		assert.ok(counts.every((request) => request.filters.some(([field, operator, value]) => field === "po_date" && operator === "=" && value === "2026-10-29")))
		list.model.clearFilters(); await settle()
		assert.equal(list.model.filterCount.value, 0)
	} finally { list.close() }
})

test("restoring old quick date ranges preserves the query as an editable advanced filter", async () => {
	const list = await mountList({ saved: { quickFilters: { po_date: ["2026-10-01", "2026-10-29"] } } })
	try {
		const filters = [["po_date", "between", ["2026-10-01", "2026-10-29"]]]
		assert.deepEqual(list.model.query.filters, filters)
		assert.deepEqual(list.model.quickValues.value, {})
		assert.equal(list.model.filterCount.value, 1)
		assert.deepEqual(JSON.parse(new URL(list.rows()[0][0], "http://site").searchParams.get("filters")), filters)
	} finally { list.close() }
})

test("live list/related events coalesce at 500ms and preserve loaded count/scroll; reconnect refreshes once", async (t) => {
	const list = await mountList()
	t.mock.timers.enable({ apis: ["setTimeout"] })
	try {
		await list.model.loadMore()
		window.scrollY = 900
		list.socket.fire("list_update", { doctype: purchaseOrder.doctype })
		t.mock.timers.tick(400)
		list.socket.fire("list_update", { doctype: "MGK Goods Received Note" })
		t.mock.timers.tick(499); await settle()
		assert.equal(list.rows().length, 2)
		t.mock.timers.tick(1); await settle()
		assert.equal(list.rows().length, 3)
		assert.equal(list.counts().length, 2)
		assert.equal(new URL(list.rows().at(-1)[0], "http://site").searchParams.get("limit"), "40")
		assert.equal(window.scrollY, 900)
		list.socket.disconnect().connect(); await settle()
		assert.equal(list.rows().length, 4)
		assert.equal(list.counts().length, 3)
	} finally { list.close() }
	assert.deepEqual(list.socket.emitted.slice(-2), [["doctype_unsubscribe", "MGK Purchase Order"], ["doctype_unsubscribe", "MGK Goods Received Note"]])
})

test("restored state fetches the loaded range and restores scroll after loading ends", async () => {
	const list = await mountList({ saved: { filters: [["supplier", "=", "S-1"]], search: "PO", tab: "karigan", sortField: "creation", sortDirection: "asc", loadedCount: 60, scrollTop: 1200 }, tab: "karigan" })
	try {
		assert.equal(list.model.data.rows.length, 60)
		assert.equal(window.scrollY, 1200)
		assert.equal(list.model.query.tab, "karigan")
		assert.equal(list.model.query.sortField, "creation")
		assert.equal(list.model.query.filters[0][2], "S-1")
	} finally { list.close() }
})

test("New stages the active tab defaults, URL tab changes refetch, and create permission gates staging", async () => {
	const list = await mountList({ tab: "karigan" })
	try {
		list.model.create(); await settle()
		const token = list.router.currentRoute.value.query.defaults
		assert.deepEqual(readNewDefaults(token, purchaseOrder.doctype, list.storage).defaults, { is_karigan_order: 1 })
		await list.router.push("/purchase-order?tab=salavai-cone"); await settle()
		assert.equal(list.model.query.tab, "salavai-cone")
	} finally { list.close() }
	const restricted = await mountList({ canCreate: false })
	try {
		assert.equal(restricted.model.canCreate, false)
		restricted.model.create(); await settle()
		assert.equal(restricted.router.currentRoute.value.path, "/purchase-order")
	} finally { restricted.close() }
})
