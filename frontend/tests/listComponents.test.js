import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { reactive } from "vue"
import { createRouter, createMemoryHistory } from "vue-router"
import { clearReadCaches } from "../src/api/client.js"
import { realtime } from "../src/realtime/socket.js"
import { masters, contactMaster } from "../src/masters/mastersConfig.js"
import purchaseOrder from "../src/books/purchase-order/config.js"
import grn from "../src/books/goods-received-note/config.js"
import challan from "../src/books/delivery-challan/config.js"
import billing from "../src/books/billing/config.js"
import stock from "../src/books/stock/config.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { loadComponent, mountComponent, nodes, textContent, settle } from "./helpers/component.js"

test("sort direction is one icon-only button with an action label/title and unchanged events", async () => {
	const events = []
	const props = reactive({ sortField: "modified", sortDirection: "desc", onDirection: () => events.push("direction"),
		onSort: (field) => events.push(field), onColumns: () => events.push("columns") })
	const page = await mountComponent("../../src/list/ListToolbar.vue", props)
	try {
		for (const direction of ["desc", "asc"]) {
			props.sortDirection = direction
			await settle()
			const buttons = nodes(page.root, (node) => node.tag === "button" && node.props.class.includes("sort-direction"))
			assert.equal(buttons.length, 1)
			assert.equal(textContent(buttons[0]), "")
			const action = direction === "asc" ? "Sort descending" : "Sort ascending"
			assert.equal(buttons[0].props["aria-label"], action)
			assert.equal(buttons[0].props.title, action)
			assert.equal(nodes(buttons[0], (node) => node.tag === "i")[0].props.class, `pi ${direction === "asc" ? "pi-sort-amount-up-alt" : "pi-sort-amount-down"}`)
			buttons[0].props.onClick()
		}
		assert.doesNotMatch(textContent(page.root), /Sort by|Asc|Desc|Filter configuration/)
		const select = nodes(page.root, (node) => node.tag === "select")[0]
		assert.equal(select.props["aria-label"], "Sort by")
		select.props.onChange({ target: { value: "creation" } })
		nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Columns")[0].props.onClick()
		assert.deepEqual(events, ["direction", "direction", "creation", "columns"])
	} finally { page.close() }
})

test("column configuration dialog is titled Columns", async () => {
	const page = await mountComponent("../../src/list/ColumnsDialog.vue", { visible: true, doctype: purchaseOrder.doctype })
	try { assert.equal(nodes(page.root, (node) => node.tag === "dialog")[0].props.header, "Columns") }
	finally { page.close() }
})

test("all quick filter types put their labels inside controls and retain accessible labels and values", async () => {
	const fields = [
		{ fieldname: "supplier", label: "Supplier", fieldtype: "Link", options: "Supplier" },
		{ fieldname: "status", label: "Status", fieldtype: "Select", options: "Open\nClosed" },
		{ fieldname: "po_date", label: "PO Date", fieldtype: "Date" },
		{ fieldname: "bill_no", label: "Supplier Invoice No.", fieldtype: "Data" },
		{ fieldname: "against_purchase_order", label: "Against Purchase Order", fieldtype: "Check" },
		{ fieldname: "docstatus", label: "Document Status", fieldtype: "Select", choices: [[0, "Draft"], [1, "Submitted"]] },
	]
	const updates = []
	const props = reactive({ fields, modelValue: { against_purchase_order: 0, docstatus: 0 }, "onUpdate:modelValue": (value) => updates.push(value) })
	const page = await mountComponent("../../src/list/QuickFilters.vue", props)
	try {
		assert.equal(nodes(page.root, (node) => node.tag === "label").length, 0)
		assert.equal(nodes(page.root, (node) => node.props.id === "quick-docstatus")[0].props.value, 0)
		assert.equal(nodes(page.root, (node) => node.props.id === "quick-against_purchase_order")[0].props.value, 0)
		for (const field of fields) {
			const controls = nodes(page.root, (node) => node.props.id === `quick-${field.fieldname}`)
			assert.equal(controls.length, 1, field.label)
			const control = controls[0]
			assert.equal(control.props["aria-label"], field.label)
			if (control.tag === "select") assert.equal(textContent(control.options[0]), field.label)
			else assert.equal(control.props.placeholder, field.label)
			const value = field.fieldtype === "Date" ? "2026-10-30" : "0"
			const handler = control.props.onChange || control.props.onInput
			handler({ target: { value } })
			assert.deepEqual(updates.at(-1), { ...props.modelValue, [field.fieldname]: value })
		}
		assert.equal(nodes(page.root, (node) => node.tag === "input" && node.props.type === "date").length, 0)
		props.modelValue.po_date = "2026-10-30"
		await settle()
		const date = nodes(page.root, (node) => node.props.id === "quick-po_date")[0]
		assert.equal(date.props["data-date-format"], "dd-mm-yy")
		assert.equal(date.props.value, "2026-10-30")
		date.props.onInput({ target: { value: "" } })
		assert.equal(updates.at(-1).po_date, "")
	} finally { page.close() }
})

async function mountListPage(book, path, stockOptions = { suppliers: [], warehouses: [], items: [], received_types: [] }, { user = {}, rows = [], fields = [] } = {}) {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: [book.doctype, "Warehouse"], can_create: [book.doctype], ...user } } },
		sessionStorage: { getItem: () => null, setItem() {} }, scrollY: 0, scrollTo() {} }
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(),
		reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	const requests = []
	globalThis.fetch = async (url) => {
		requests.push(url)
		return { ok: true, status: 200, json: async () => url.includes("getdoctype")
		? { docs: [{ name: book.doctype, fields }] } : url.includes("get_user_listview") ? { message: null }
			: url.includes("get_counts") ? { message: [0, 0, 0, 0] } : url.includes("get_stock_note")
				? { message: { rows: [], summary: {}, options: stockOptions } } : { data: rows } }
	}
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/manage/:master", component: { render: () => null } }, { path: "/:pathMatch(.*)*", component: { render: () => null } }] })
	await router.push(book.routePath)
	const page = await mountComponent(`../../src/${path}`, {}, [router])
	await settle()
	return { ...page, requests, close() { page.close(); Object.assign(realtime, original.realtime); globalThis.window = original.window; globalThis.fetch = original.fetch; clearReadCaches() } }
}

test("ListView no longer declares the removed header props", async () => {
	const component = (await loadComponent("../../src/list/ListView.vue")).default
	for (const prop of ["code", "cover", "description"]) assert.equal(Object.hasOwn(component.props, prop), false, prop)
})

test("every book and master list uses the breadcrumb title with New and no large heading or description", async () => {
	const pages = [purchaseOrder, grn, challan, billing].map((book) => [book, `books/${book.key}/${{
		"purchase-order": "PurchaseOrder", "goods-received-note": "GoodsReceivedNote", "delivery-challan": "DeliveryChallan", billing: "Billing",
	}[book.key]}ListPage.vue`])
	pages.push(...[...masters, contactMaster].map((master) => [master, "masters/MasterListPage.vue"]))
	for (const [book, path] of pages) {
		const page = await mountListPage(book, path)
		try {
			const section = nodes(page.root, (node) => node.tag === "section" && node.props.class.includes("book-list-page"))[0]
			assert.deepEqual(Object.keys(section.props), ["class"], `${book.label} must not leak configuration attributes`)
			const headers = nodes(page.root, (node) => node.tag === "header" && node.props.class === "list-page-header")
			assert.equal(headers.length, 1, book.label)
			const isMaster = book.route?.startsWith("/manage/")
			assert.equal(textContent(nodes(headers[0], (node) => node.tag === "nav")[0]), isMaster ? `All books›Manage›${book.label}` : `All books›${book.label}`)
			const back = nodes(headers[0], (node) => node.tag === "a" && node.props.class === "head-back")
			assert.deepEqual(back.map((node) => node.props.href), isMaster ? ["/manage"] : [], book.label)
			assert.equal(nodes(headers[0], (node) => node.props["aria-current"] === "page").length, 1)
			assert.equal(nodes(headers[0], (node) => node.tag === "button" && textContent(node) === "+ New").length, 1)
			assert.equal(nodes(headers[0], (node) => node.tag === "p").length, 0)
			assert.equal(nodes(page.root, (node) => node.tag === "h1").length, 0)
			assert.ok(!textContent(page.root).includes(book.description))
			assert.doesNotMatch(textContent(page.root), /MGK digital books|Unable to load this list/)
		} finally { page.close() }
	}
})

test("master table lists offer bulk Delete only with delete permission and click-to-filter shows a removable chip", async () => {
	const supplier = masters.find((master) => master.doctype === "Supplier")
	const fields = [{ fieldname: "tax_id", label: "GSTIN", fieldtype: "Data" }]
	const rows = [{ name: "S-1", tax_id: "33ABC", disabled: 0, docstatus: 0 }]
	for (const canDelete of [false, true]) {
		const page = await mountListPage(supplier, "masters/MasterListPage.vue", undefined, { user: canDelete ? { can_delete: ["Supplier"] } : {}, rows, fields })
		try {
			const checkboxes = () => nodes(page.root, (node) => node.tag === "input" && node.props.type === "checkbox")
			assert.equal(checkboxes().length, canDelete ? 2 : 0)
			if (canDelete) {
				checkboxes()[1].props.onChange(); await settle()
				assert.ok(nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Delete (1)")[0])
			}
			const value = nodes(page.root, (node) => node.tag === "span" && textContent(node) === "33ABC")[0]
			assert.match(value.props.class.join?.(" ") ?? JSON.stringify(value.props.class), /list-filter-value/)
			value.props.onClick({ stopPropagation() {} }); await settle()
			const chip = nodes(page.root, (node) => node.props.class === "filter-chip")[0]
			assert.equal(textContent(chip), "GSTIN = 33ABC×")
			assert.match(decodeURIComponent(page.requests.at(-1)), /"tax_id","=","33ABC"/)
			nodes(chip, (node) => node.tag === "button")[0].props.onClick(); await settle()
			assert.equal(nodes(page.root, (node) => node.props.class === "filter-chip").length, 0)
		} finally { page.close() }
	}
})

test("Stock picker labels appear only inside controls and selected values reach the stock request", async () => {
	const options = {
		suppliers: [{ name: "S-1", supplier_name: "Supplier One" }], warehouses: [{ name: "W-1", supplier: "S-1" }],
		items: [{ name: "I-1", item_name: "Yarn" }], received_types: [{ name: "Accepted" }],
		title_fields: { Supplier: "supplier_name", Item: "item_name" },
	}
	const page = await mountListPage(stock, "books/stock/StockListPage.vue", options)
	try {
		const selects = nodes(page.root, (node) => node.tag === "select")
		assert.equal(selects.length, 4)
		for (const [index, label] of ["Supplier", "Warehouse", "Item", "Received type"].entries()) {
			const control = selects[index]
			assert.equal(control.props["aria-label"], label)
			assert.equal(textContent(control.options[0]), label)
			assert.equal(control.options[0].props.value, "")
			assert.equal(nodes(control.parent, (node) => node.tag === "span").length, 0)
			control.props["onUpdate:modelValue"](control.options[1].props.value)
		}
		await settle()
		assert.deepEqual(selects.map((control) => control.selectedIndex), [1, 1, 1, 1])
		assert.equal(textContent(selects[0].options[1]), "Supplier One")
		assert.equal(textContent(selects[2].options[1]), "Yarn")
		await nodes(page.root, (node) => node.tag === "form")[0].props.onSubmit({ preventDefault() {} })
		const filters = JSON.parse(new URL(page.requests.at(-1), "http://site").searchParams.get("filters"))
		assert.deepEqual([filters.supplier, filters.warehouse, filters.item, filters.received_type], ["S-1", "W-1", "I-1", "Accepted"])
	} finally { page.close() }
})

test("topbar uses the same 12px horizontal gutters as list pages on desktop and mobile", () => {
	const css = readFileSync(new URL("../src/theme/base.css", import.meta.url), "utf8")
	const topbars = [...css.matchAll(/\.ops-topbar\s*\{([^}]+)\}/g)]
	assert.equal(topbars.length, 2)
	for (const [, rule] of topbars) assert.match(rule, /padding:\s*0 12px;/)
	assert.match(css, /\.page\.list-page\s*\{[^}]*padding:\s*22px 12px 60px;/)
})

test("Stock and Manage also use the compact shared header without descriptions", async () => {
	for (const [book, path, title] of [
		[stock, "books/stock/StockListPage.vue", "Stock"],
		[{ doctype: "Warehouse", routePath: "/manage" }, "books/masters/MastersListPage.vue", "Manage"],
	]) {
		const page = await mountListPage(book, path)
		try {
			const header = nodes(page.root, (node) => node.tag === "header" && node.props.class === "list-page-header")[0]
			assert.equal(textContent(header), `All books›${title}`)
			assert.equal(nodes(page.root, (node) => node.tag === "h1").length, 0)
			assert.doesNotMatch(textContent(page.root), /Available stock by supplier|Keep your stock and party|Company stores and supplier warehouses/)
		} finally { page.close() }
	}
})
