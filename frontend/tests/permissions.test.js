import test from "node:test"
import assert from "node:assert/strict"
import { bookManifest } from "../src/books/manifest.js"
import { canReadBook, hasPermission, readableMasters } from "../src/permissions/usePermissions.js"
import { getHomeBlocks } from "../src/layout/homeLayout.js"

const stockUser = { can_read: ["MGK Delivery Challan", "MGK Goods Received Note", "YRP Stock Ledger Entry", "Warehouse"] }

test("Stock User book visibility excludes Billing and PO", () => {
	assert.deepEqual(bookManifest.filter((book) => canReadBook(book, stockUser)).map((book) => book.key),
		["delivery-challan", "goods-received-note", "stock", "masters"])
	assert.equal(canReadBook(bookManifest.find((book) => book.key === "billing"), stockUser), false)
})

test("Stock requires stock ledger and Warehouse access and Manage requires at least one master", () => {
	const stock = bookManifest.find((book) => book.key === "stock")
	const manage = bookManifest.find((book) => book.key === "masters")
	assert.equal(canReadBook(stock, { can_read: ["Warehouse"] }), false)
	assert.equal(canReadBook(stock, { can_read: ["YRP Stock Ledger Entry"] }), false)
	assert.equal(canReadBook(stock, stockUser), true)
	assert.equal(canReadBook(manage, { can_read: ["MGK Delivery Challan"] }), false)
	assert.deepEqual(readableMasters(stockUser).map((master) => master.doctype), ["Warehouse"])
})

test("read/create/write are separate and missing permissions deny access", () => {
	assert.equal(hasPermission("Item", "read", {}), false)
	assert.equal(hasPermission("Item", "create", { can_read: ["Item"] }), false)
	assert.equal(hasPermission("Item", "write", { can_create: ["Item"] }), false)
})

test("layout fallback happens before permission filtering", () => {
	const visible = getHomeBlocks({}).filter((block) => {
		const book = bookManifest.find((entry) => entry.type === block.type)
		return canReadBook(book, { can_read: [] })
	})
	assert.deepEqual(visible, [])
})
