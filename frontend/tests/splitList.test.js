import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { reactive } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { ignoresNavigation, navigateSelection, reconcileSelection, selectionTotals } from "../src/list/useSplitSelection.js"
import { realtime } from "../src/realtime/socket.js"
import { clearReadCaches } from "../src/api/client.js"
import { formatDisplayDatetime } from "../src/document/activityFormat.js"
import challan from "../src/books/delivery-challan/config.js"
import receipt from "../src/books/goods-received-note/config.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, settle, textContent } from "./helpers/component.js"

const records = () => ["A", "B", "C"].map((name) => ({ name, supplier: `Supplier ${name}`, po_date: "2026-10-30", total_qty: 10, total_amount: 50, docstatus: 1, modified: "one" }))

async function mountSplit({ phone = false, selected = "", rows = records(), doctype = "MGK Purchase Order", preview = {}, user = {}, respond } = {}) {
	const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, realtime: { ...realtime } }
	const scrolls = []
	const socket = new FakeSocket()
	globalThis.document = { querySelector: (selector) => selector === ".ops-topbar" ? { getBoundingClientRect: () => ({ height: 58 }) } : null }
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: [doctype], ...user } } },
		matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
		scrollY: 640, scrollTo: (position) => scrolls.push(position.top), sessionStorage: { getItem: () => null, setItem() {} } }
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(),
		reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => socket })
	const requests = []
	globalThis.fetch = async (url, options) => {
		requests.push(url)
		const name = new URL(url, "http://site").searchParams.get("name")
		const message = {
			items: [], connections: [], timeline: [], extra: {}, ...preview,
			doc: { ...rows.find((row) => row.name === name), name, ...preview.doc },
		}
		const result = respond ? await respond(url, options, message) : message
		return { ok: true, status: 200, json: async () => ({ message: result }) }
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
	return { ...page, props, router, requests, socket, scrolls, close() {
		page.close(); Object.assign(realtime, original.realtime); globalThis.window = original.window; globalThis.document = original.document; globalThis.fetch = original.fetch; clearReadCaches()
	} }
}
const options = (page) => nodes(page.root, (node) => node.props.role === "option")
const selectedOption = (page) => options(page).find((node) => node.props["aria-selected"])
const checkboxes = (page) => nodes(page.root, (node) => node.tag === "input" && node.props.type === "checkbox")
const key = (page, value, target = {}) => nodes(page.root, (node) => node.props.onKeydown)[0].props.onKeydown({ key: value, target, preventDefault() {} })
const button = (page, label) => nodes(page.root, (node) => node.tag === "button" && textContent(node) === label)[0]

test("split list renders accessible rows, selects first row and shows columns in secondary line", async () => {
	const page = await mountSplit()
	try {
		assert.equal(options(page).length, 3)
		assert.equal(nodes(page.root, (node) => node.props.role === "listbox").length, 1)
		assert.match(textContent(selectedOption(page)), /A/)
		assert.equal(page.props.selected, "A")
		assert.equal(page.router.currentRoute.value.query.selected, "A")
		assert.match(textContent(options(page)[0]), /Supplier A.*2026-10-30.*10 qty.*50.00/)
	} finally { page.close() }
})

test("loaded route selection wins and row click replaces desktop query", async () => {
	const page = await mountSplit({ selected: "B" })
	try {
		assert.equal(page.props.selected, "B")
		await options(page)[2].props.onClick()
		await settle()
		assert.equal(page.router.currentRoute.value.query.selected, "C")
	} finally { page.close() }
})

test("last-row ArrowDown awaits loadMore before selecting the next row", async () => {
	let rows = [{ name: "A" }]
	let finish
	let calls = 0
	const pending = navigateSelection({ rows: () => rows, selected: "A", direction: 1, hasMore: () => true,
		loadMore: () => { calls++; return new Promise((resolve) => { finish = () => { rows.push({ name: "B" }); resolve() } }) } })
	assert.equal(calls, 1)
	finish()
	assert.equal(await pending, "B")
})

test("navigation clamps at the ends and a failed load keeps the last row", async () => {
	const rows = records()
	const move = (selected, direction, hasMore = false) => navigateSelection({ rows: () => rows, selected, direction, hasMore: () => hasMore, loadMore: async () => {} })
	assert.equal(await move("A", -1), "A")
	assert.equal(await move("C", 1), "C")
	assert.equal(await move("C", 1, true), "C")
	assert.equal(ignoresNavigation({ target: { closest: () => true } }), true)
	assert.equal(ignoresNavigation({}, true), true)
})

test("live removal selects the next row at the old index, then previous, then empty", () => {
	const rows = records()
	assert.equal(reconcileSelection([rows[0], rows[2]], "B", rows), "C")
	assert.equal(reconcileSelection(rows.slice(0, 2), "C", rows), "B")
	assert.equal(reconcileSelection([], "C", rows), "")
})

test("refresh updates selection and bulk names are pruned; query changes clear bulk", async () => {
	const page = await mountSplit({ selected: "B" })
	try {
		checkboxes(page)[2].props.onChange()
		await settle()
		assert.match(textContent(page.root), /1 selected/)
		page.props.rows = [page.props.rows[0], page.props.rows[2]]
		await settle()
		assert.equal(page.props.selected, "C")
		assert.doesNotMatch(textContent(page.root), /1 selected/)
		checkboxes(page)[0].props.onChange()
		await settle()
		assert.match(textContent(page.root), /2 selected/)
		page.props.queryKey = "two"
		await settle()
		assert.doesNotMatch(textContent(page.root), /2 selected/)
	} finally { page.close() }
})

test("Escape clears bulk and Enter opens the selected document", async () => {
	const page = await mountSplit()
	try {
		checkboxes(page)[0].props.onChange()
		await settle()
		key(page, "Escape", { closest: () => true })
		await settle()
		assert.doesNotMatch(textContent(page.root), /3 selected/)
		key(page, "Enter")
		await settle()
		assert.equal(page.router.currentRoute.value.path, "/purchase-order/A")
	} finally { page.close() }
})

test("phone starts with list, row pushes preview query and browser Back restores scroll", async () => {
	const page = await mountSplit({ phone: true })
	try {
		assert.equal(page.router.currentRoute.value.query.selected, undefined)
		await options(page)[1].props.onClick()
		await settle()
		assert.equal(page.router.currentRoute.value.query.selected, "B")
		assert.match(nodes(page.root, (node) => node.props.onKeydown)[0].props.class, /preview-open/)
		assert.equal(page.scrolls.at(-1), 640 + 420 - 58)
		page.router.back()
		await settle()
		await settle()
		assert.equal(page.router.currentRoute.value.query.selected, undefined)
		assert.equal(page.scrolls.at(-1), 640)
	} finally { page.close() }
})

test("selection totals use each book's quantity and amount fields", () => {
	assert.deepEqual(selectionTotals(records()), { quantity: 30, amount: 150, hasAmount: true })
	assert.deepEqual(selectionTotals([{ total_output_qty: 7, total_dc_value: 125 }]), { quantity: 7, amount: 125, hasAmount: true })
	assert.equal(selectionTotals([{ total_qty: 1 }]).hasAmount, false)
})

test("selection summary formats Currency with two decimals and Float with list precision", async () => {
	const page = await mountComponent("../../src/list/SelectionSummary.vue", {
		rows: [{ total_qty: 1.234567, total_amount: 154 }], refresh() {},
	})
	try {
		assert.match(textContent(page.root), /Total quantity1\.234567/)
		assert.match(textContent(page.root), /Total amount154\.00/)
	} finally { page.close() }
})

test("DC preview hides unavailable and non-internal transit columns and shows shared transit intro", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	for (const is_internal_transfer of [0, 1]) {
		const page = await mountSplit({ doctype: "MGK Delivery Challan", preview: {
			doc: { docstatus: 1, is_internal_transfer },
			items: [{ item: "Yarn", qty: 10, transferred_qty: 3, returned_qty: 4, conversion_factor: 2, uom: "Kg" }],
		} })
		try {
			context.mock.timers.tick(120); await settle()
			const headers = nodes(page.root, (node) => node.tag === "th").map(textContent)
			assert.equal(headers.includes("Received back"), false)
			assert.equal(headers.includes("Out"), false)
			assert.doesNotMatch(textContent(page.root), /Still Out/)
			for (const label of ["Transferred", "Returned", "Pending in transit"]) assert.equal(headers.includes(label), Boolean(is_internal_transfer))
			assert.equal(textContent(page.root).includes("Pending in transit: Yarn 5 Kg"), Boolean(is_internal_transfer))
		} finally { page.close() }
	}
})

test("preview timeline uses the Activity datetime formatter without microseconds", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const at = "2026-10-30 18:16:10.355306"
	const page = await mountSplit({ preview: { timeline: [{ at, text: "Submitted" }] } })
	try {
		context.mock.timers.tick(120); await settle()
		assert.equal(textContent(nodes(page.root, (node) => node.tag === "time")[0]), formatDisplayDatetime(at))
		assert.doesNotMatch(textContent(page.root), /355306/)
	} finally { page.close() }
})

test("bulk actions receive names and rows through the shared runner", async () => {
	const page = await mountSplit()
	let target
	try {
		page.props.bulkActions = [{ key: "collect", label: "Collect", run: async (selection) => { target = selection; return { message: "Ready" } } }]
		checkboxes(page)[0].props.onChange()
		await settle()
		await nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Collect")[0].props.onClick()
		await settle()
		assert.deepEqual(target.names, ["A", "B", "C"])
		assert.equal(target.rows.length, 3)
		assert.equal(target.doc, undefined)
		assert.match(textContent(page.root), /Ready/)
		nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Clear")[0].props.onClick()
		await settle()
		assert.doesNotMatch(textContent(page.root), /3 selected/)
	} finally { page.close() }
})

test("phone Back to list clears a directly linked preview without leaving the list", async () => {
	const page = await mountSplit({ phone: true, selected: "B" })
	try {
		await nodes(page.root, (node) => node.tag === "button" && textContent(node) === "‹ Back to list")[0].props.onClick()
		await settle()
		assert.equal(page.router.currentRoute.value.path, "/purchase-order")
		assert.equal(page.router.currentRoute.value.query.selected, undefined)
	} finally { page.close() }
})

test("empty live results clear selection and remove the old preview", async () => {
	const page = await mountSplit({ selected: "B" })
	try {
		page.props.rows = []
		await settle()
		assert.equal(page.props.selected, "")
		assert.equal(page.router.currentRoute.value.query.selected, undefined)
		assert.match(textContent(page.root), /No records found.*Select a document/)
	} finally { page.close() }
})

test("document events refresh after 300ms trailing, switch rooms, and refetch on reconnect", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const page = await mountSplit()
	const fire = (name) => page.socket.fire("doc_update", { doctype: "MGK Purchase Order", name })
	const tick = async (delay) => { context.mock.timers.tick(delay); await settle() }
	try {
		await tick(120)
		assert.equal(page.requests.length, 1)
		fire("A")
		await tick(200)
		fire("A")
		await tick(299)
		assert.equal(page.requests.length, 1)
		await tick(1)
		assert.equal(page.requests.length, 2)
		await options(page)[1].props.onClick()
		await settle()
		assert.equal(realtime.rooms.has(JSON.stringify(["doc", "MGK Purchase Order", "A"])), false)
		assert.equal(realtime.rooms.has(JSON.stringify(["doc", "MGK Purchase Order", "B"])), true)
		fire("A")
		await tick(120)
		assert.equal(page.requests.length, 3)
		page.socket.disconnect()
		page.socket.connect()
		await tick(300)
		assert.equal(page.requests.length, 4)
	} finally { page.close() }
})

test("split CSS uses existing tokens and confines tables at the phone breakpoint", () => {
	const css = readFileSync(new URL("../src/list/split.css", import.meta.url), "utf8")
	assert.match(css, /minmax\(300px, 380px\) minmax\(0, 1fr\)/)
	assert.match(css, /@media \(max-width: 760px\)/)
	assert.match(css, /\.split-preview[^}]+min-height: calc\(100dvh - 58px\)/)
	assert.match(css, /\.preview-pane \.table-scroll[^}]+min-width: 0/)
	assert.doesNotMatch(css, /#[\da-f]{3,8}\b|--[\w-]+\s*:/i)
})

test("bulk actions render only with the target document create permission", async () => {
	for (const [book, target] of [[challan, receipt], [receipt, challan]]) {
		assert.deepEqual(book.bulkActions[0].permission, [target.doctype, "create"])
		for (const permission of ["read", "write", "create"]) {
			const page = await mountSplit({ doctype: book.doctype, user: { [`can_${permission}`]: [target.doctype] } })
			try {
				page.props.bulkActions = book.bulkActions
				checkboxes(page)[0].props.onChange()
				await settle()
				assert.equal(Boolean(button(page, book.bulkActions[0].label)), permission === "create")
			} finally { page.close() }
		}
	}
})

test("list and related events evict unselected previews even when modified is unchanged", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	for (const doctype of ["MGK Purchase Order", "MGK Goods Received Note"]) {
		let revision = 1
		const page = await mountSplit({ respond: (_url, _options, message) => ({ ...message, doc: { ...message.doc, supplier: `Revision ${revision}` } }) })
		const tick = async (delay) => { context.mock.timers.tick(delay); await settle() }
		try {
			page.props.relatedDoctypes = ["MGK Goods Received Note"]
			await settle(); await tick(120)
			await options(page)[1].props.onClick(); await settle(); await tick(120)
			assert.equal(page.requests.length, 2)
			revision = 2
			page.socket.fire("list_update", { doctype })
			await tick(300)
			assert.equal(page.requests.length, 3)
			await options(page)[0].props.onClick(); await settle(); await tick(120)
			assert.equal(page.requests.length, 4)
			assert.match(textContent(nodes(page.root, (node) => node.tag === "article")[0]), /Revision 2/)
			assert.equal(page.props.rows[0].modified, "one")
		} finally { page.close() }
	}
})

test("reconnect evicts unselected previews and doc events force reads at the same modified", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const page = await mountSplit()
	const tick = async (delay) => { context.mock.timers.tick(delay); await settle() }
	try {
		await tick(120)
		await options(page)[1].props.onClick(); await settle(); await tick(120)
		page.socket.disconnect(); page.socket.connect(); await tick(300)
		assert.equal(page.requests.length, 3)
		await options(page)[0].props.onClick(); await settle(); await tick(120)
		assert.equal(page.requests.length, 4)
		page.socket.fire("doc_update", { doctype: page.props.doctype, name: "A", modified: "one" })
		await tick(300)
		assert.equal(page.requests.length, 5)
	} finally { page.close() }
})

test("selection changes suppress mapped navigation and retain mutation single flight", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	let finish, mutations = 0
	const page = await mountSplit({ user: { can_create: [receipt.doctype] }, preview: { doc: { items: [{ pending_qty: 1 }] } },
		respond: (_url, options, message) => options.method === "POST"
			? new Promise((resolve) => { mutations++; finish = resolve }) : message })
	const tick = async () => { context.mock.timers.tick(120); await settle() }
	try {
		await tick()
		const running = button(page, "Create GRN").props.onClick()
		await settle()
		await options(page)[1].props.onClick(); await settle(); await tick()
		assert.equal(button(page, "Create GRN").props.disabled, true)
		await button(page, "Create GRN").props.onClick()
		assert.equal(mutations, 1)
		finish({ doctype: receipt.doctype, name: "new" }); await running; await settle()
		assert.equal(page.router.currentRoute.value.path, "/purchase-order")
		assert.equal(page.router.currentRoute.value.query.selected, "B")
		assert.equal(button(page, "Create GRN").props.disabled, false)
		assert.equal(nodes(page.root, (node) => node.props.class === "server-error").length, 0)
	} finally { finish?.({}); page.close() }
})

test("selection changes clear completed action errors and results", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	for (const hasError of [false, true]) {
		const message = hasError ? "Source is closed." : "Created and submitted:"
		const page = await mountSplit({ user: { can_create: [receipt.doctype] }, preview: { doc: { items: [{ pending_qty: 1 }] } },
			respond: (_url, options, preview) => {
				if (options.method !== "POST") return preview
				if (hasError) throw new Error(message)
				return { goods_received_note: "GRN-A" }
			} })
		const tick = async () => { context.mock.timers.tick(120); await settle() }
		try {
			await tick()
			const running = button(page, hasError ? "Create GRN" : "Mark as Received").props.onClick()
			if (!hasError) { await settle(); button(page, "Confirm").props.onClick() }
			await running; await settle()
			assert.ok(textContent(page.root).includes(message))
			await options(page)[1].props.onClick(); await settle(); await tick()
			assert.equal(textContent(page.root).includes(message), false)
		} finally { page.close() }
	}
})
