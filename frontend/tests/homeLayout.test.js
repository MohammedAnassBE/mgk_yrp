import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { defaultBlocks, getHomeBlocks } from "../src/layout/homeLayout.js"
import { canReadBook } from "../src/permissions/usePermissions.js"
import { bookManifest, manifestByType } from "../src/books/manifest.js"
import { mountComponent, nodes, textContent } from "./helpers/component.js"

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

test("fallback order is PO, Billing, Pending Bills, DC, GRN, Stock, Masters, Credits & Debits without DC Close or Payment Ledger cards", () => {
	const types = ["purchase-order", "billing", "pending-bills", "delivery-challan", "goods-received-note", "stock", "masters", "supplier-credit-debit"]
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
		assert.ok(blocks.every((block) => block.type !== "mgk-delivery-challan-close"), record.name)
		assert.ok(blocks.every((block) => !["mgk-supplier-credits", "mgk-supplier-debits"].includes(block.type)), record.name)
		if (["MGK Workspace", "Billing"].includes(record.name)) assert.equal(blocks.filter((block) => block.type === "mgk-supplier-credit-debit").length, 1, record.name)
	}
})

test("DC Close is never a home card, even when configured or readable", () => {
	const close = { id: "delivery-challan-close", type: "mgk-delivery-challan-close" }
	assert.deepEqual(getHomeBlocks(layout([dc, close, grn])), [dc, grn])
	const user = { can_read: ["MGK Delivery Challan", "MGK Delivery Challan Close"] }
	const visible = getHomeBlocks({}).filter((block) => canReadBook(manifestByType[block.type], user))
	assert.deepEqual(visible.map((block) => block.type), ["mgk-delivery-challan"])
})

test("home book New links require create permission and are siblings of the card link", async () => {
	const original = globalThis.window
	for (const has_create of [false, true]) {
		globalThis.window = { frappe: { boot: { user: { can_create: has_create ? ["MGK Purchase Order"] : [] } } } }
		const book = bookManifest.find((book) => book.key === "purchase-order")
		const page = await mountComponent("../../src/shared/BookCard.vue", { book })
		try {
			const links = nodes(page.root, (node) => node.tag === "a")
			assert.equal(links.length, has_create ? 2 : 1)
			assert.equal(links[0].props.href, "/purchase-order")
			if (has_create) {
				assert.equal(textContent(links[1]), "+ New")
				assert.match(links[1].props.class, /\bcover-po\b/)
				assert.doesNotMatch(links[1].props.class, /\bsecondary\b/)
				assert.equal(links[1].props.href, "/purchase-order/new")
				assert.equal(links[1].parent, links[0].parent)
				assert.equal(links[1].props.tabindex, undefined)
				assert.equal(links[1].parent.props.onClick, undefined)
			}
		} finally { page.close(); globalThis.window = original }
	}
})

test("Stock and Manage links render compact at the right of the home header", async () => {
	const source = readFileSync(new URL("../src/home/HomePage.vue", import.meta.url), "utf8")
	const header = source.slice(source.indexOf('<header class="home-heading">'), source.indexOf("</header>"))
	assert.ok(header.indexOf("<h1>") < header.indexOf('class="heading-actions home-heading-actions"'))
	assert.ok(header.includes('v-for="block in actionBlocks"'))
	assert.equal(source.indexOf("home-heading-actions", source.indexOf("</header>")), -1)
	const css = readFileSync(new URL("../src/theme/base.css", import.meta.url), "utf8")
	assert.match(css, /\.heading-actions \{ display: flex; gap: 8px; margin-left: auto; \}/)
	assert.match(css, /\.home-heading-actions \{ flex-wrap: wrap; justify-content: flex-end; max-width: 100%; \}/)
	assert.match(css, /\.home-heading-actions \.button \{ min-height: 36px;/)
	const actions = getHomeBlocks({}).filter((block) => manifestByType[block.type].presentation === "action").map((block) => block.type)
	assert.deepEqual(actions, ["mgk-stock", "mgk-masters"])
})
