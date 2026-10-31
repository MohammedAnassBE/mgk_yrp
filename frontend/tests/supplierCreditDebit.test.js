import test from "node:test"
import assert from "node:assert/strict"
import { bookRegistry } from "../src/books/registry.js"
import { homeManifestByType } from "../src/books/manifest.js"
import { documentModule } from "../src/documents/registry.js"
import { statusPill, indicatorFields } from "../src/list/statusPill.js"
import { mountComponent, nodes } from "./helpers/component.js"

const doctype = "MGK Supplier Credit Debit"

test("one Credits & Debits card opens the shared list on All with an untyped New", () => {
	const book = homeManifestByType["mgk-supplier-credit-debit"]
	assert.equal(book.label, "Credits & Debits")
	assert.equal(book.cover, "cover-credit")
	assert.equal(book.homePath, undefined)
	assert.equal(book.newPath, undefined)
	assert.equal(book.countFilters, undefined)
	assert.ok(!homeManifestByType["mgk-supplier-credits"] && !homeManifestByType["mgk-supplier-debits"])
	assert.deepEqual(book.tabs.map((tab) => tab.label), ["All", "Credit", "Debit"])
	assert.deepEqual(book.defaultColumns, ["name", "supplier", "posting_date", "entry_type", "amount", "reason"])
	assert.deepEqual(book.queryDefaults, ["entry_type"])
})

test("Credits & Debits card links to the list and a New form without a type", async () => {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { user: { can_create: [doctype] } } } }
	const page = await mountComponent("../../src/shared/BookCard.vue", { book: bookRegistry["mgk-supplier-credit-debit"] })
	try {
		const links = nodes(page.root, (node) => node.tag === "a")
		assert.equal(links[0].props.href, "/supplier-credit-debit")
		assert.equal(links[1].props.href, "/supplier-credit-debit/new")
		assert.match(links[1].props.class, /\bcover-credit\b/)
	} finally { page.close(); globalThis.window = original }
})

test("compact form, preview facts and type pill", () => {
	const module = documentModule(doctype)
	assert.deepEqual(module.layout.paperFields, ["supplier", "posting_date", "entry_type", "amount", "reason"])
	assert.equal(module.layout.compact, true)
	const facts = module.preview.facts({ supplier: "Buying Supplier", posting_date: "2026-10-31", entry_type: "Debit", amount: 250, reason: "Short supply" })
	assert.deepEqual(facts.map((fact) => [fact.label, fact.value]), [["Supplier", "Buying Supplier"], ["Date", "31-10-2026"], ["Type", "Debit"], ["Amount", "250.00"], ["Reason", "Short supply"]])
	assert.deepEqual(module.preview.itemColumns, [])
	assert.equal(statusPill(doctype, { entry_type: "Credit" }).label, "Credit")
	assert.equal(statusPill(doctype, { entry_type: "Debit" }).className, "status-pending")
	assert.deepEqual(indicatorFields(doctype), ["entry_type"])
})
