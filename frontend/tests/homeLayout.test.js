import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { defaultBlocks, getHomeBlocks } from "../src/layout/homeLayout.js"
import { canReadBook } from "../src/permissions/usePermissions.js"
import { bookManifest, manifestByType } from "../src/books/manifest.js"

const layout = (blocks, hidden = {}) => ({ ui_config: { config: { screens: { home: { blocks, hidden } } } } })
const dc = { id: "dc", type: "mgk-delivery-challan", size: "half", props: { title: "Dispatch" } }
const grn = { id: "grn", type: "mgk-goods-received-note" }

test("keeps a configured subset, its order, size and props", () => {
	assert.deepEqual(getHomeBlocks(layout([grn, dc])), [grn, dc])
	assert.deepEqual(getHomeBlocks(layout([dc, grn])), [dc, grn])
})

test("ignores unknown blocks while retaining registered blocks", () => {
	assert.deepEqual(getHomeBlocks(layout([{ id: "other", type: "other" }, dc, null, grn])), [dc, grn])
})

test("boolean true hides and false shows", () => {
	assert.deepEqual(getHomeBlocks(layout([dc, grn], { dc: false, grn: true })), [dc])
	assert.deepEqual(getHomeBlocks(layout([dc, grn], { dc: true, grn: false })), [grn])
	assert.deepEqual(getHomeBlocks(layout([dc], { dc: "true" })), [dc])
})

test("all configured blocks hidden produces an empty layout", () => {
	assert.deepEqual(getHomeBlocks(layout([dc, grn], { dc: true, grn: true })), [])
})

test("fallback order is PO, Billing, DC, DC Close, GRN, Stock, Masters", () => {
	const types = ["purchase-order", "billing", "delivery-challan", "delivery-challan-close", "goods-received-note", "stock", "masters"]
	assert.deepEqual(getHomeBlocks({}).map((block) => block.type), types.map((key) => `mgk-${key}`))
	assert.deepEqual(getHomeBlocks(layout([])), defaultBlocks)
	assert.deepEqual(getHomeBlocks(layout([{ id: "unknown", type: "unknown" }])), defaultBlocks)
	assert.deepEqual(getHomeBlocks({ ui_config: null }), defaultBlocks)
})

test("visibility applies to the fallback too, without reintroducing it", () => {
	const hidden = Object.fromEntries(defaultBlocks.map((block) => [block.id, true]))
	assert.deepEqual(getHomeBlocks(layout([], hidden)), [])
})

test("layout resolution does not mutate boot data", () => {
	const boot = layout([dc, grn], { grn: true })
	const snapshot = structuredClone(boot)
	const result = getHomeBlocks(boot)
	result[0].id = "changed"
	assert.deepEqual(boot, snapshot)
})

test("shipped layouts resolve their books without adding Stock or Manage links", () => {
	const fixture = new URL("../../mgk_yrp/fixtures/yrp_ui_layout.json", import.meta.url)
	const layouts = JSON.parse(readFileSync(fixture, "utf8"))
	for (const record of layouts) {
		const config = JSON.parse(record.config)
		const blocks = getHomeBlocks({ ui_config: { config } })
		assert.deepEqual(blocks, config.screens.home.blocks, record.name)
		assert.ok(blocks.every((block) => !["mgk-stock", "mgk-masters"].includes(block.type)), record.name)
		const position = blocks.findIndex((block) => block.type === "mgk-delivery-challan")
		if (position >= 0) assert.equal(blocks[position + 1].type, "mgk-delivery-challan-close", record.name)
	}
})

test("DC Close is visible after DC only to users with its read permission", () => {
	const close = bookManifest.find((book) => book.key === "delivery-challan-close")
	assert.equal(canReadBook(close, { can_read: ["MGK Delivery Challan"] }), false)
	const user = { can_read: ["MGK Delivery Challan", "MGK Delivery Challan Close"] }
	const visible = getHomeBlocks({}).filter((block) => canReadBook(manifestByType[block.type], user))
	assert.deepEqual(visible.map((block) => block.type), ["mgk-delivery-challan", "mgk-delivery-challan-close"])
})
