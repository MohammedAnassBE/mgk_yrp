import test from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { bookManifest } from "../src/books/manifest.js"
import { books, bookRegistry } from "../src/books/registry.js"

const required = ["type", "key", "doctype", "label", "code", "cover", "routePath", "tabs", "defaultColumns", "card", "routes"]

test("all six modules export the complete contract and own routes/cards", async () => {
	assert.equal(books.length, 6)
	assert.equal(new Set(books.map((book) => book.type)).size, 6)
	for (const book of books) {
		for (const key of required) assert.ok(Object.hasOwn(book, key), `${book.key} missing ${key}`)
		assert.equal(bookRegistry[book.type], book)
		const metadata = bookManifest.find((entry) => entry.type === book.type)
		for (const key of Object.keys(metadata)) assert.deepEqual(book[key], metadata[key])
		assert.equal(typeof book.card, "function")
		assert.equal(book.routes[0].path, book.routePath)
		assert.equal(book.routes[0].meta.bookType, book.type)
		assert.equal(typeof book.routes[0].component, "function")
		const files = await readdir(new URL(`../src/books/${book.key}/`, import.meta.url))
		assert.ok(files.some((file) => file.endsWith("Card.vue")))
		assert.ok(files.some((file) => file.endsWith("ListPage.vue")))
	}
})

test("no book imports another book", async () => {
	for (const book of books) {
		const directory = new URL(`../src/books/${book.key}/`, import.meta.url)
		for (const file of await readdir(directory)) {
			const source = await readFile(new URL(file, directory), "utf8")
			const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)]
			for (const [, target] of imports) {
				for (const other of books.filter((entry) => entry.key !== book.key)) {
					assert.ok(!target.includes(`/${other.key}/`), `${book.key} imports ${other.key}`)
				}
			}
		}
	}
})

test("list tab definitions preserve Desk filters for the next wave", () => {
	const tabs = (key) => bookRegistry[`mgk-${key}`].tabs
	assert.deepEqual(tabs("purchase-order").map((tab) => tab.label), ["All", "Karigan", "Salavai Cone"])
	assert.deepEqual(tabs("purchase-order")[1].filters, [["is_karigan_order", "=", 1]])
	assert.deepEqual(tabs("purchase-order")[2].filters, [["is_salavai_cone_order", "=", 1]])
	assert.deepEqual(tabs("goods-received-note")[1].filters, [["against_purchase_order", "=", 0]])
	assert.deepEqual(tabs("goods-received-note")[2].filters, [["against_purchase_order", "=", 1]])
	assert.deepEqual(tabs("billing")[1].filters, [["against", "=", "Job Work"]])
	assert.deepEqual(tabs("billing")[2].filters, [["against", "=", "Purchase Order"]])
	assert.deepEqual(tabs("delivery-challan"), [])
	for (const book of books.filter((entry) => entry.tabs.length)) {
		assert.equal(book.tabs[0].key, "all")
		assert.deepEqual(book.tabs[0].filters, [])
	}
})

test("list columns and tab filters refer to real Desk fields", async () => {
	for (const book of books.filter((entry) => entry.presentation === "book")) {
		const doctype = book.doctype.toLowerCase().replaceAll(" ", "_")
		const source = new URL(`../../mgk_yrp/mgk_yrp/doctype/${doctype}/${doctype}.json`, import.meta.url)
		const schema = JSON.parse(await readFile(source, "utf8"))
		const fields = new Set(["name", "docstatus", ...schema.fields.map((field) => field.fieldname)])
		for (const field of book.defaultColumns) assert.ok(fields.has(field), `${book.key}: unknown column ${field}`)
		for (const tab of book.tabs) {
			for (const [field] of tab.filters) assert.ok(fields.has(field), `${book.key}: unknown filter ${field}`)
		}
	}
})

test("book metadata exposes useful standard quick filters and declares every related live room", async () => {
	const expected = {
		"purchase-order": ["supplier", "po_date", "status", "delivery_location"],
		"goods-received-note": ["supplier", "posting_date", "purchase_order", "warehouse"],
		billing: ["supplier", "posting_date", "against", "bill_no"],
		"delivery-challan": ["from_location", "to_location", "process_name", "posting_date", "close_status"],
	}
	for (const book of books.filter((entry) => entry.presentation === "book")) {
		const name = book.doctype.toLowerCase().replaceAll(" ", "_")
		const schema = JSON.parse(await readFile(new URL(`../../mgk_yrp/mgk_yrp/doctype/${name}/${name}.json`, import.meta.url), "utf8"))
		for (const field of expected[book.key]) assert.equal(schema.fields.find((candidate) => candidate.fieldname === field).in_standard_filter, 1)
	}
	assert.deepEqual(bookRegistry["mgk-purchase-order"].relatedDoctypes, ["MGK Goods Received Note"])
	assert.deepEqual(bookRegistry["mgk-goods-received-note"].relatedDoctypes, ["MGK Purchase Invoice"])
	assert.deepEqual(bookRegistry["mgk-delivery-challan"].relatedDoctypes, ["MGK Goods Received Note", "MGK Delivery Challan Close"])
})
