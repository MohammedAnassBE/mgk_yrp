import test from "node:test"
import assert from "node:assert/strict"
import { createRouter, createMemoryHistory } from "vue-router"
import { clearReadCaches } from "../src/api/client.js"
import { realtime } from "../src/realtime/socket.js"
import { canReadBook } from "../src/permissions/usePermissions.js"
import { bookRegistry } from "../src/books/registry.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

const doctype = "MGK Supplier Credit Debit"
const book = bookRegistry["mgk-payment-ledger"]
const ledger = {
	opening_balance: 0,
	rows: [
		{ date: "2026-10-01", name: "MGK-SCD-26-00001", entry_type: "Credit", supplier_name: "Buying Supplier", supplier: "Buying Supplier", reason: "Advance", debit: 0, credit: 1500, balance: 1500 },
		{ date: "2026-10-02", name: "MGK-SCD-26-00002", entry_type: "Debit", supplier_name: "Buying Supplier", supplier: "Buying Supplier", reason: "Short supply", debit: 750, credit: 0, balance: 750 },
		{ date: "2026-10-03", name: "MGK-PI-26-00001", type: "Bill", entry_type: "Credit", supplier_name: "Buying Supplier", supplier: "Buying Supplier", reason: "Bill · INV-123", debit: 0, credit: 500, balance: 1250 },
	],
	suppliers: [{ supplier: "Buying Supplier", supplier_name: "Buying Supplier", opening: 0, credit: 1500, debit: 750, balance: 750 }],
	totals: { credit: 1500, debit: 750, balance: 750 },
}

async function mountLedger() {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: [doctype, "Supplier"] } } } }
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(),
		reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	const requests = []
	globalThis.fetch = async (url) => {
		requests.push(decodeURIComponent(String(url)))
		return { ok: true, status: 200, json: async () => ({ message: String(url).includes("get_payment_ledger") ? ledger : [] }) }
	}
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] })
	await router.push(book.routePath)
	const page = await mountComponent("../../src/books/payment-ledger/PaymentLedgerListPage.vue", {}, [router])
	await settle()
	return { ...page, requests, close() { page.close(); Object.assign(realtime, original.realtime); globalThis.window = original.window; globalThis.fetch = original.fetch; clearReadCaches() } }
}

test("Payment Ledger is a read-only action route visible to Credit Debit readers", () => {
	assert.equal(book.routePath, "/payment-ledger")
	assert.equal(book.presentation, "action")
	assert.equal(canReadBook(book, { can_read: [doctype] }), true)
	assert.equal(canReadBook(book, { can_read: [] }), false)
})

test("Payment Ledger lists every entry on open with totals and collapsed supplier balances", async () => {
	const page = await mountLedger()
	try {
		assert.ok(page.requests.some((url) => url.includes("mgk_yrp.web.payment_ledger.get_payment_ledger")))
		const cards = nodes(page.root, (node) => node.tag === "article").map(textContent)
		assert.deepEqual(cards, ["Total Credit₹1,500.00", "Total Debit₹750.00", "Balance₹750.00"])
		const headers = nodes(page.root, (node) => node.tag === "th").map(textContent)
		assert.deepEqual(headers, ["Date", "Supplier", "Type", "Document", "Reason", "Credit", "Debit", "Supplier running balance"])
		const types = nodes(page.root, (node) => node.tag === "span" && String(node.props.class).includes("ledger-type")).map(textContent)
		assert.deepEqual(types, ["Credit", "Debit", "Bill"])
		const links = nodes(page.root, (node) => node.tag === "a" && String(node.props.href).startsWith("/supplier-credit-debit/"))
		assert.deepEqual(links.map((link) => link.props.href), ["/supplier-credit-debit/MGK-SCD-26-00001", "/supplier-credit-debit/MGK-SCD-26-00002"])
		const billLinks = nodes(page.root, (node) => node.tag === "a" && String(node.props.href).startsWith("/billing/"))
		assert.deepEqual(billLinks.map((link) => link.props.href), ["/billing/MGK-PI-26-00001"])
		const footer = nodes(page.root, (node) => node.tag === "tr" && node.props.class === "ledger-total").map(textContent)
		assert.deepEqual(footer, ["Total₹1,500.00₹750.00₹750.00"])
		assert.ok(textContent(page.root).includes("Bill · INV-123"))
		assert.ok(textContent(page.root).includes("02-10-2026"))
		assert.ok(!textContent(page.root).includes("2026-10-02"))
		assert.ok(textContent(page.root).includes("Supplier balances"))
		assert.equal(nodes(page.root, (node) => node.tag === "button" && node.props.class === "ledger-link").length, 0)
		nodes(page.root, (node) => node.tag === "button" && node.props.class === "ledger-toggle")[0].props.onClick()
		await settle()
		const supplierButton = nodes(page.root, (node) => node.tag === "button" && node.props.class === "ledger-link")[0]
		supplierButton.props.onClick()
		await settle()
		const lastLedger = page.requests.filter((url) => url.includes("get_payment_ledger")).at(-1)
		assert.equal(new URLSearchParams(lastLedger.split("?")[1]).get("supplier"), "Buying Supplier")
		assert.ok(nodes(page.root, (node) => node.tag === "th").map(textContent).includes("Balance"))
		const ledgerRequests = () => page.requests.filter((url) => url.includes("get_payment_ledger")).length
		const before = ledgerRequests()
		const supplierInput = () => nodes(page.root, (node) => node.tag === "input" && node.props.id === "ledger-supplier")[0]
		supplierInput().props.onInput({ target: { value: "Buy" } })
		await new Promise((resolve) => setTimeout(resolve, 300))
		await settle()
		assert.equal(ledgerRequests(), before)
		supplierInput().props.onInput({ target: { value: "" } })
		await settle()
		assert.equal(ledgerRequests(), before + 1)
		assert.equal(new URLSearchParams(page.requests.filter((url) => url.includes("get_payment_ledger")).at(-1).split("?")[1]).get("supplier"), "")
	} finally { page.close() }
})
