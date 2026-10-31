import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { reactive } from "vue"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { summary as poSummary } from "../src/documents/purchase-order/presentation.js"
import { summary as grnSummary } from "../src/documents/goods-received-note/presentation.js"
import { groupGrnRows } from "../src/documents/purchase-invoice/fieldEvents.js"
import { editorPermissions } from "../src/item-editor/editorModes.js"
import { clearReadCaches } from "../src/api/client.js"

const button = (root, label) => nodes(root, (node) => node.tag === "button" && textContent(node) === label)[0]
async function invoiceMetadata() {
	return JSON.parse(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_purchase_invoice_item/mgk_purchase_invoice_item.json", import.meta.url)))
}

test("Before saving shows circles for incomplete steps and ticks only completed PO/GRN steps", async () => {
	for (const summary of [poSummary, grnSummary]) {
		const props = reactive({ summary: summary({}, 0), editing: true, book: { code: "PO" } })
		const page = await mountComponent("../../src/document/DocumentSummary.vue", props)
		try {
			assert.ok(nodes(page.root, (node) => node.tag === "i").every((node) => node.props.class === "pi pi-circle"))
			props.summary = summary({ supplier: "Vendor", po_date: "2026-10-29", delivery_location: "Own", warehouse: "W",
				goods_routing: "Direct", total_qty: 2, total_amount: 10 }, 1)
			await settle()
			assert.ok(nodes(page.root, (node) => node.tag === "i").every((node) => node.props.class === "pi pi-check"))
			props.summary = summary({ supplier: "Vendor", po_date: "2026-10-29" }, 0)
			await settle()
			assert.deepEqual(nodes(page.root, (node) => node.tag === "i").map((node) => node.props.class), ["pi pi-check", "pi pi-circle", "pi pi-circle"])
		} finally { page.close() }
	}
})

test("attribute matrix add controls expose size quantity/rate accessible names", async () => {
	const original = globalThis.fetch
	globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ message: url.includes("get_attribute_details")
		? { attributes: [], primary_attribute: "Size", primary_attribute_values: ["S", "M"], default_uom: "Nos" }
		: [{ value: "Tee" }] }) })
	const page = await mountComponent("../../src/item-editor/StockItemEntry.vue", {
		mode: "po", defaults: {}, dimensions: [], poEntries: [], permissions: editorPermissions("po"),
	})
	try {
		const item = nodes(page.root, (node) => node.tag === "input")[0]
		await item.props.onFocus(); await settle()
		nodes(page.root, (node) => node.tag === "li")[0].props.onMousedown({ preventDefault() {} })
		await settle()
		assert.deepEqual(nodes(page.root, (node) => node.tag === "input" && node.props.role !== "combobox" && node.props["aria-label"]).map((node) => node.props["aria-label"]),
			["S quantity", "M quantity", "S rate", "M rate"])
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("Billing step 2 lists selected GRNs with links and remove, groups items by item + GRN rate and edits a group rate on every row", async () => {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: ["MGK Goods Received Note"] } } } }
	const meta = await invoiceMetadata()
	const doc = { docstatus: 0, items: [
		{ item: "Yarn", qty: 2, grn_rate: 10, rate: 10, goods_received_note: "GRN-1", goods_received_note_item: "row-1" },
		{ item: "Fabric", qty: 3, grn_rate: 20, rate: 20, goods_received_note: "GRN-2", goods_received_note_item: "row-2" },
		{ item: "Yarn", qty: 4, grn_rate: 10, rate: 11, goods_received_note: "GRN-2", goods_received_note_item: "row-3" },
	] }
	const props = reactive({ doc, groups: groupGrnRows(doc.items), dates: { "GRN-1": "2026-10-29" }, meta: { permissions: [] }, metas: [meta],
		onChange: (name, rows) => { props.doc.items = rows; props.groups = groupGrnRows(rows) } })
	const page = await mountComponent("../../src/documents/purchase-invoice/InvoiceRows.vue", props)
	try {
		assert.deepEqual(nodes(page.root, (node) => node.tag === "a").map((node) => node.props.href), ["/goods-received-note/GRN-1", "/goods-received-note/GRN-2"])
		assert.ok(textContent(page.root).includes("29-10-2026"))
		const inputs = nodes(page.root, (node) => node.tag === "input")
		assert.deepEqual(inputs.map((node) => node.props["aria-label"]), ["Yarn rate", "Fabric rate"])
		inputs[0].props.onInput({ target: { value: "12.5" } })
		assert.deepEqual(props.doc.items.map((row) => row.rate), [12.5, 20, 12.5])
		assert.deepEqual(props.doc.items.map((row) => row.qty), [2, 3, 4])
		await settle()
		const removes = nodes(page.root, (node) => node.tag === "button")
		assert.deepEqual(removes.map((node) => node.props["aria-label"]), ["Remove GRN-1", "Remove GRN-2"])
		removes[0].props.onClick()
		assert.deepEqual(props.doc.items.map((row) => row.goods_received_note_item), ["row-2", "row-3"])
		props.disabled = true
		await settle()
		assert.equal(nodes(page.root, (node) => node.tag === "input").length, 0)
		assert.equal(nodes(page.root, (node) => node.tag === "button").length, 0)
	} finally { page.close(); globalThis.window = original }
})

test("Billing Get GRNs sits in step 2, displays a GRN ID/Date/Total Qty/Total Amount table, fetches taxes and emits the warning", async () => {
	const original = { window: globalThis.window, fetch: globalThis.fetch }
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: [] } } } }
	const calls = [], messages = [], states = []
	globalThis.fetch = async (url, options) => {
		calls.push({ url, body: JSON.parse(options.body) })
		if (url.endsWith("get_unbilled_grns")) return { ok: true, status: 200, json: async () => ({ message: [{ name: "GRN-1", posting_date: "2026-10-29", total_qty: 2, total_amount: 20 }] }) }
		if (url.endsWith("get_grn_rows")) return { ok: true, status: 200, json: async () => ({ message: [{ item: "Yarn", qty: 2, rate: 10, goods_received_note: "GRN-1" }] }) }
		return { ok: true, status: 200, json: async () => ({ docs: [{ ...props.doc, net_total: 20, grand_total: 20, tax_type: "IGST" }], _server_messages: '["Missing slab warning"]' }) }
	}
	const props = reactive({ doc: { doctype: "MGK Purchase Invoice", docstatus: 0, supplier: "Vendor", against: "Job Work", items: [] },
		meta: { permissions: [] }, metas: [await invoiceMetadata()], onUpdate: (patch) => Object.assign(props.doc, patch),
		onMessages: (values) => messages.push(...values), onLoading: (state) => states.push(state) })
	const page = await mountComponent("../../src/documents/purchase-invoice/InvoiceItems.vue", props)
	try {
		await button(page.root, "Get GRNs").props.onClick(); await settle()
		for (const text of ["GRN ID", "Date", "Total Qty", "Total Amount", "GRN-1", "29-10-2026", "20.00"]) assert.ok(textContent(page.root).includes(text), text)
		const choice = nodes(page.root, (node) => node.tag === "input" && node.props.type === "checkbox")[0]
		choice.props["onUpdate:modelValue"](["GRN-1"])
		await settle()
		await button(page.root, "Fetch").props.onClick(); await settle()
		assert.deepEqual(calls[1].body.grn_names, ["GRN-1"])
		assert.equal(calls[2].url, "/api/method/run_doc_method")
		assert.equal(calls[2].body.method, "preview_taxes")
		assert.equal(props.doc.grand_total, 20)
		assert.deepEqual(messages, ["Missing slab warning"])
		assert.deepEqual(states, [true, false, true, false])
		props.doc.docstatus = 1
		await settle()
		assert.equal(button(page.root, "Get GRNs"), undefined)
	} finally { page.close(); Object.assign(globalThis, original); clearReadCaches() }
})

test("Close toolbar has primary Reopen with exact confirmation and suppresses Amend while reversing", async () => {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { user: { can_cancel: ["MGK Delivery Challan Close"], can_amend: ["MGK Delivery Challan Close"], can_create: ["MGK Delivery Challan Close"] } } } }
	const actions = []
	const props = reactive({ doc: { doctype: "MGK Delivery Challan Close", name: "CLOSE-1", delivery_challan: "DC-1", docstatus: 1 }, meta: {}, onAction: (name) => actions.push(name) })
	const page = await mountComponent("../../src/document/DocumentActions.vue", props)
	try {
		assert.equal(button(page.root, "Cancel"), undefined)
		assert.equal(button(page.root, "Reopen").props.severity, undefined)
		await button(page.root, "Reopen").props.onClick(); await settle()
		assert.ok(textContent(page.root).includes("Reopen Delivery Challan DC-1? Its valuation will be reversed before stock is released."))
		await button(page.root, "Confirm").props.onClick(); await settle()
		assert.deepEqual(actions, ["cancel"])
		props.doc.docstatus = 2
		for (const reopen_status of ["Reversing", "Reopening"]) {
			props.doc.reopen_status = reopen_status
			await settle()
			assert.equal(button(page.root, "Amend"), undefined)
		}
		props.doc.reopen_status = "Reopened"
		await settle()
		assert.ok(button(page.root, "Amend"))
	} finally { page.close(); globalThis.window = original }
})
