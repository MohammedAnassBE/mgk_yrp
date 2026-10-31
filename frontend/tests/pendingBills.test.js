import test from "node:test"
import assert from "node:assert/strict"
import { createRouter, createMemoryHistory } from "vue-router"
import { clearReadCaches } from "../src/api/client.js"
import { realtime } from "../src/realtime/socket.js"
import { canReadBook } from "../src/permissions/usePermissions.js"
import { bookRegistry } from "../src/books/registry.js"
import { allChecked, billPayload, blockTotals, buildBlocks, failedSupplier, itemTooltip, keepPending, selectedBySupplier, setDraftRate, toggleAll, validateBlocks } from "../src/books/pending-bills/pendingBills.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

const book = bookRegistry["mgk-pending-bills"]
const grn = (name, aging, bucket, against = "Job Work", amount = 100) => ({ name, aging, bucket, against, posting_date: "2026-09-16", total_qty: 2, total_amount: amount,
	items: [{ item: "ITEM-1", item_name: "Cotton Yarn", qty: 2, rate: amount / 2, amount }] })
const pending = { count: 4, suppliers: [
	{ supplier: "SUP-B", supplier_name: "Beta Mills", grn_count: 2, total_amount: 300, total_aging: 75, grns: [grn("GRN-B1", 40, "30+"), grn("GRN-B2", 35, "30+", "Purchase Order", 200)] },
	{ supplier: "SUP-A", supplier_name: "Alpha Traders", grn_count: 2, total_amount: 200, total_aging: 53, grns: [grn("GRN-A1", 45, "30+"), grn("GRN-A2", 8, "8-15")] },
] }
const row = (name, item, rate, against = "Job Work") => ({ goods_received_note: name, goods_received_note_item: `${name}-row`, item, item_name: item, uom: "Kg", qty: 2, grn_rate: rate, rate, amount: rate * 2, gst_rate: 5, cgst_amount: rate * 0.05, sgst_amount: rate * 0.05, igst_amount: 0, against })
const draft = (supplier, against, rows) => ({ supplier, against, tax_type: "CGST + SGST", items: rows })

test("Pending Bills is a Billing-purple home book that needs GRN and Billing read access and counts unbilled GRNs", () => {
	assert.equal(book.routePath, "/pending-bills")
	assert.equal(book.cover, "cover-pi")
	assert.equal(book.showCreate, false)
	assert.deepEqual(book.countFilters, [["docstatus", "=", 1], ["purchase_invoice", "is", "not set"]])
	assert.equal(canReadBook(book, { can_read: ["MGK Goods Received Note", "MGK Purchase Invoice"] }), true)
	assert.equal(canReadBook(book, { can_read: ["MGK Goods Received Note"] }), false)
})

test("selection keeps the server supplier order, supports select-all and drops GRNs that leave the list", () => {
	let selected = toggleAll(new Set(), ["GRN-A1", "GRN-B2"], true)
	assert.deepEqual(selectedBySupplier(pending.suppliers, selected).map((group) => [group.supplier, group.grns]), [["SUP-B", ["GRN-B2"]], ["SUP-A", ["GRN-A1"]]])
	selected = toggleAll(selected, ["GRN-B1", "GRN-B2"], true)
	assert.equal(allChecked(selected, ["GRN-B1", "GRN-B2"]), true)
	assert.equal(allChecked(selected, []), false)
	selected = toggleAll(selected, ["GRN-B1"], false)
	assert.equal(allChecked(selected, ["GRN-B1", "GRN-B2"]), false)
	assert.deepEqual([...keepPending(new Set(["GRN-A1", "GONE"]), pending.suppliers)], ["GRN-A1"])
	assert.equal(itemTooltip(pending.suppliers[0].grns[0]), "Cotton Yarn · 2 × 50 = 100")
})

test("popup blocks group rows by item, edit rates live and validate invoice no and date", () => {
	const [block] = buildBlocks([{ supplier: "SUP-B", supplier_name: "Beta Mills", grns: ["GRN-B1", "GRN-B2"] }],
		[draft("SUP-B", "Job Work", [row("GRN-B1", "ITEM-1", 50), row("GRN-B3", "ITEM-1", 50)]), draft("SUP-B", "Purchase Order", [row("GRN-B2", "ITEM-2", 100, "Purchase Order")]), draft("SUP-X", "Job Work", [])], "2026-10-31")
	assert.equal(block.bill_date, "2026-10-31")
	assert.deepEqual(block.drafts.map((entry) => entry.against), ["Job Work", "Purchase Order"])
	block.drafts[0] = setDraftRate(block.drafts[0], [0, 1], 60)
	assert.deepEqual(block.drafts[0].items.map((entry) => [entry.rate, entry.amount, entry.cgst_amount]), [[60, 120, 3], [60, 120, 3]])
	assert.equal(block.drafts[0].net_total, 240)
	assert.deepEqual(blockTotals(block), { net_total: 440, total_tax: 22, grand_total: 462 })
	assert.equal(validateBlocks([block])[0].error, "Supplier Invoice No is required.")
	assert.equal(validateBlocks([{ ...block, bill_no: "INV-1", bill_date: "" }])[0].error, "Supplier Invoice Date is required.")
	assert.deepEqual(billPayload([{ ...block, bill_no: " INV-1 " }]), [{ supplier: "SUP-B", bill_no: "INV-1", bill_date: "2026-10-31", grns: ["GRN-B1", "GRN-B2"],
		rates: { "GRN-B1-row": 60, "GRN-B3-row": 60, "GRN-B2-row": 100 } }])
	assert.equal(failedSupplier({ payload: { _server_messages: JSON.stringify([JSON.stringify({ message: "x", title: "SUP-A" })]) } }), "SUP-A")
	assert.equal(failedSupplier(new Error("plain")), "")
})

async function mountPage(createResponse) {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: ["MGK Goods Received Note", "MGK Purchase Invoice"],
		can_create: ["MGK Purchase Invoice"], can_submit: ["MGK Purchase Invoice"] } } } }
	const socket = new FakeSocket()
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => socket })
	const requests = []
	globalThis.fetch = async (url, options = {}) => {
		const body = options.body ? JSON.parse(options.body) : {}
		requests.push({ url: decodeURIComponent(String(url)), body })
		if (String(url).includes("get_bill_drafts")) return { ok: true, status: 200, json: async () => ({ message: [draft("SUP-B", "Job Work", [row("GRN-B1", "ITEM-1", 50)]), draft("SUP-A", "Job Work", [row("GRN-A1", "ITEM-1", 50)])] }) }
		if (String(url).includes("create_bills")) return createResponse(body)
		return { ok: true, status: 200, json: async () => ({ message: String(url).includes("get_pending_bills") ? pending : [] }) }
	}
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] })
	await router.push(book.routePath)
	const page = await mountComponent("../../src/books/pending-bills/PendingBillsListPage.vue", {}, [router])
	await settle()
	return { ...page, requests, socket, close() { page.close(); Object.assign(realtime, original.realtime); globalThis.window = original.window; globalThis.fetch = original.fetch; clearReadCaches() } }
}
const find = (root, predicate) => nodes(root, predicate)[0]
const byLabel = (root, label) => find(root, (node) => node.props["aria-label"] === label)
const button = (root, label) => find(root, (node) => node.tag === "button" && textContent(node).startsWith(label))
const type = async (input, value) => { input.props.onInput({ target: { value } }); await settle() }

test("page lists suppliers by summed aging with GRN links, DD-MM-YYYY dates and aging tags, then bulk-creates bills", async () => {
	let attempt = 0
	const page = await mountPage(() => {
		attempt += 1
		if (attempt === 1) return { ok: false, status: 417, json: async () => ({ exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message: "GRN GRN-A1 is already billed.", title: "SUP-A" })]) }) }
		return { ok: true, status: 200, json: async () => ({ message: [{ name: "MGK-PI-26-00007", supplier: "SUP-B" }, { name: "MGK-PI-26-00008", supplier: "SUP-A" }] }) }
	})
	try {
		const headings = nodes(page.root, (node) => node.tag === "h2").map(textContent)
		assert.deepEqual(headings, ["Beta Mills", "Alpha Traders"])
		assert.ok(textContent(page.root).includes("2 GRNs · 300.00 · 75 days"))
		const links = nodes(page.root, (node) => node.tag === "a" && String(node.props.href).startsWith("/goods-received-note/")).map((node) => node.props.href)
		assert.deepEqual(links, ["/goods-received-note/GRN-B1", "/goods-received-note/GRN-B2", "/goods-received-note/GRN-A1", "/goods-received-note/GRN-A2"])
		assert.ok(textContent(page.root).includes("16-09-2026") && !textContent(page.root).includes("2026-09-16"))
		assert.deepEqual(nodes(page.root, (node) => node.tag === "th").slice(0, 7).map(textContent), ["", "GRN", "Date", "Aging", "Type", "Qty", "Amount"])
		assert.ok(textContent(page.root).includes("8–15 8d"))
		assert.equal(find(page.root, (node) => node.tag === "tr" && node.props.title === "Cotton Yarn · 2 × 50 = 100") !== undefined, true)
		assert.equal(button(page.root, "Make Bill").props.disabled, true)
		byLabel(page.root, "Select all GRNs of Beta Mills").props.onChange({ target: { checked: true } })
		byLabel(page.root, "Select GRN-A1").props.onChange({ target: { checked: true } })
		await settle()
		button(page.root, "Make Bill").props.onClick()
		await settle()
		const draftsRequest = page.requests.find((entry) => entry.url.includes("get_bill_drafts"))
		assert.deepEqual(draftsRequest.body.grn_names, ["GRN-B1", "GRN-B2", "GRN-A1"])
		assert.deepEqual(nodes(page.root, (node) => node.tag === "h3").map(textContent), ["Beta Mills", "Alpha Traders"])
		await type(byLabel(page.root, "ITEM-1 rate"), "55")
		assert.ok(textContent(page.root).includes("Grand Total 115.50"))
		button(page.root, "Create & Submit Bills").props.onClick()
		await settle()
		assert.equal(nodes(page.root, (node) => node.props.role === "alert").map(textContent).filter((text) => text.includes("Supplier Invoice No is required.")).length, 2)
		assert.equal(page.requests.filter((entry) => entry.url.includes("create_bills")).length, 0)
		await type(byLabel(page.root, "Beta Mills Supplier Invoice No"), "B-77")
		await type(byLabel(page.root, "Alpha Traders Supplier Invoice No"), "A-12")
		const create = button(page.root, "Create & Submit Bills")
		create.props.onClick()
		create.props.onClick()
		await settle()
		assert.equal(page.requests.filter((entry) => entry.url.includes("create_bills")).length, 1)
		const blocks = nodes(page.root, (node) => node.tag === "section" && String(node.props.class).includes("make-bill-block"))
		assert.ok(textContent(blocks[1]).includes("GRN GRN-A1 is already billed."))
		assert.ok(!textContent(blocks[0]).includes("already billed"))
		const [request] = page.requests.filter((entry) => entry.url.includes("create_bills"))
		assert.deepEqual(request.body.bills.map((bill) => [bill.supplier, bill.bill_no, bill.grns]), [["SUP-B", "B-77", ["GRN-B1", "GRN-B2"]], ["SUP-A", "A-12", ["GRN-A1"]]])
		assert.equal(request.body.bills[0].rates["GRN-B1-row"], 55)
		const loadsBefore = page.requests.filter((entry) => entry.url.includes("get_pending_bills")).length
		button(page.root, "Create & Submit Bills").props.onClick()
		await settle()
		const created = nodes(page.root, (node) => node.tag === "a" && String(node.props.href).startsWith("/billing/")).map((node) => node.props.href)
		assert.deepEqual(created, ["/billing/MGK-PI-26-00007", "/billing/MGK-PI-26-00008"])
		assert.equal(nodes(page.root, (node) => node.tag === "dialog").length, 0)
		assert.ok(page.requests.filter((entry) => entry.url.includes("get_pending_bills")).length > loadsBefore)
	} finally { page.close() }
})

test("removing a GRN from the Make Bill popup drops its rows, empty drafts and empty suppliers", async () => {
	const { removeGrn } = await import("../src/books/pending-bills/pendingBills.js")
	const row = (grn, amount) => ({ goods_received_note: grn, qty: 1, rate: amount, amount, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })
	const blocks = [
		{ supplier: "A", grns: ["G1", "G2"], drafts: [{ against: "Purchase Order", items: [row("G1", 10), row("G2", 5)] }] },
		{ supplier: "B", grns: ["G3"], drafts: [{ against: "Job Work", items: [row("G3", 7)] }] },
	]
	const next = removeGrn(blocks, "G1")
	assert.deepEqual(next[0].grns, ["G2"])
	assert.equal(next[0].drafts[0].items.length, 1)
	assert.equal(next[0].drafts[0].grand_total, 5)
	assert.equal(blocks[0].grns.length, 2)
	assert.deepEqual(removeGrn(next, "G3").map((block) => block.supplier), ["A"])
})
