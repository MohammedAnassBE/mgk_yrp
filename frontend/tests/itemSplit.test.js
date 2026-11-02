import test from "node:test"
import assert from "node:assert/strict"
import { reactive } from "vue"
import { readFile } from "node:fs/promises"
import { clearReadCaches } from "../src/api/client.js"
import { setLanguage, tamilNamesSettled } from "../src/shell/displayLanguage.js"
import { t } from "../src/shell/terminology.js"
import { itemTooltip } from "../src/books/pending-bills/pendingBills.js"
import { groupGrnRows } from "../src/documents/purchase-invoice/fieldEvents.js"
import { transferItems } from "../src/documents/shared/transit.js"
import { itemRows as closeItemRows } from "../src/documents/delivery-challan-close/preview.js"
import { jobWorkMethods } from "../src/documents/shared/jobWork.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

const masters = {
	Item: [{ name: "Marathon", mgk_tamil_name: "மாரத்தான்", item_name: "Marathon", variant_of: null },
		{ name: "Marathon-Red", mgk_tamil_name: "", item_name: "Marathon-Red", variant_of: "Marathon" },
		{ name: "Cone", mgk_tamil_name: "கோன்", item_name: "Cone", variant_of: null }],
	"YRP Item Attribute Value": [{ name: "IAV-1", attribute_name: "Colour", attribute_value: "Red", mgk_tamil_name: "சிவப்பு" }],
}
const attributes = { "Marathon-Red": { item_template: "Marathon", item_attributes: { Colour: "Red" } },
	Cone: { item_template: "Cone", item_attributes: {} } }
const variantRow = { item: "Marathon-Red", item_name: "Marathon-Red", item_template: "Marathon", item_attributes: { Colour: "Red" } }
const plainRow = { item: "Cone", item_name: "Cone", item_template: "Cone", item_attributes: {} }

function stub(responses = {}) {
	const original = { fetch: globalThis.fetch, window: globalThis.window }
	const requests = []
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: ["Item", "YRP Stock Ledger Entry", "Warehouse"] } } },
		addEventListener() {}, removeEventListener() {} }
	globalThis.fetch = async (url, options = {}) => {
		const address = new URL(String(url), "http://x")
		const method = address.pathname.replace("/api/method/", "")
		const params = address.searchParams
		requests.push(method)
		let message = []
		if (method === "frappe.client.get_list") {
			const filters = JSON.parse(params.get("filters"))
			message = (masters[params.get("doctype")] || []).filter((row) => filters.every(([field, operator, value]) =>
				operator === "in" ? value.includes(row[field]) : row[field] === value))
		} else if (method === "mgk_yrp.web.preview.get_item_attributes") {
			message = Object.fromEntries(JSON.parse(params.get("items")).filter((name) => attributes[name]).map((name) => [name, attributes[name]]))
		} else if (responses[method]) message = responses[method](options.body ? JSON.parse(options.body) : {})
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	return { requests, restore() { globalThis.fetch = original.fetch; globalThis.window = original.window; clearReadCaches(); setLanguage("en") } }
}

async function resolved() { await settle(); await tamilNamesSettled(); await settle(); await tamilNamesSettled(); await settle() }
const cells = (root, tag) => nodes(root, (node) => node.tag === tag).map(textContent)

test("pending bill tooltip names the template and its attribute values, in Tamil too", async () => {
	const network = stub()
	try {
		const grn = { items: [{ ...variantRow, qty: 2, rate: 50, amount: 100 }, { ...plainRow, qty: 1, rate: 5, amount: 5 }] }
		assert.equal(itemTooltip(grn), "Marathon · Colour: Red · 2 × 50 = 100\nCone · 1 × 5 = 5")
		setLanguage("ta")
		itemTooltip(grn)
		await resolved()
		assert.equal(itemTooltip(grn), `மாரத்தான் · ${t("Colour")}: சிவப்பு · 2 × 50 = 100\nகோன் · 1 × 5 = 5`)
	} finally { network.restore() }
})

test("Make Bill shows the template, one column per attribute and keeps variant + rate grouping", async () => {
	const row = (source, rate, name) => ({ ...source, goods_received_note: "GRN-1", goods_received_note_item: name, uom: "Kg", qty: 2, grn_rate: rate,
		rate, amount: rate * 2, gst_rate: 5, cgst_amount: rate * 0.05, sgst_amount: rate * 0.05, igst_amount: 0 })
	const network = stub({ "mgk_yrp.web.pending_bills.get_bill_drafts": () => [{ supplier: "SUP", against: "Job Work", tax_type: "CGST + SGST",
		items: [row(variantRow, 50, "r1"), row(variantRow, 50, "r2"), row(variantRow, 60, "r3"), row(plainRow, 5, "r4")] }] })
	const page = await mountComponent("../../src/books/pending-bills/MakeBillDialog.vue",
		{ visible: true, groups: [{ supplier: "SUP", supplier_name: "Supplier", grns: ["GRN-1"] }] })
	try {
		await resolved()
		const table = nodes(page.root, (node) => node.tag === "table")[0]
		assert.deepEqual(cells(table, "th"), ["Item", "Colour", "UOM", "Qty", "GRN Rate", "Rate", "Amount", "GST %", "CGST", "SGST"])
		const rows = nodes(table, (node) => node.tag === "tr").slice(1).map((tr) => cells(tr, "td").slice(0, 4))
		assert.deepEqual(rows, [["Marathon", "Red", "Kg", "4"], ["Marathon", "Red", "Kg", "2"], ["Cone", "—", "Kg", "2"]])
		setLanguage("ta")
		await resolved()
		const tamil = nodes(nodes(page.root, (node) => node.tag === "table")[0], (node) => node.tag === "tr").slice(1).map((tr) => cells(tr, "td").slice(0, 2))
		assert.deepEqual(tamil, [["மாரத்தான்", "சிவப்பு"], ["மாரத்தான்", "சிவப்பு"], ["கோன்", "—"]])
	} finally { page.close(); network.restore() }
})

test("Billing rows look up templates and show attribute columns after Item, in Tamil too", async () => {
	const network = stub()
	const child = JSON.parse(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_purchase_invoice_item/mgk_purchase_invoice_item.json", import.meta.url)))
	const doc = { tax_type: "No Tax", items: [{ item: "Marathon-Red", qty: 2, uom: "Kg", grn_rate: 50, rate: 50, amount: 100, gst_rate: 0, goods_received_note: "GRN-1" },
		{ item: "Cone", qty: 1, uom: "Kg", grn_rate: 5, rate: 5, amount: 5, gst_rate: 0, goods_received_note: "GRN-1" }] }
	const props = reactive({ doc, groups: groupGrnRows(doc.items), metas: [child], meta: { permissions: [] }, disabled: true })
	const page = await mountComponent("../../src/documents/purchase-invoice/InvoiceRows.vue", props)
	const itemTable = () => nodes(page.root, (node) => node.tag === "table" && node.props.class === "invoice-item-table")[0]
	try {
		await resolved()
		assert.deepEqual(cells(itemTable(), "th").slice(0, 3), ["Item", "Colour", "Total Qty"])
		const rows = () => nodes(itemTable(), (node) => node.tag === "tr").slice(1).map((tr) => cells(tr, "td").slice(0, 2))
		assert.deepEqual(rows(), [["Marathon", "Red"], ["Cone", "—"]])
		setLanguage("ta")
		await resolved()
		assert.deepEqual(rows(), [["மாரத்தான்", "சிவப்பு"], ["கோன்", "—"]])
		assert.equal(network.requests.filter((method) => method.endsWith("get_item_attributes")).length, 1)
	} finally { page.close(); network.restore() }
})

test("transfer rows show the template item from item details, in Tamil too", async () => {
	const network = stub()
	const doc = { items: [{ name: "row-1", item: "Marathon-Red", uom: "Kg", qty: 2 }],
		item_details: [{ attributes: [], primary_attribute: "Colour", items: [{ name: "Marathon", attributes: {}, values: { Red: { name: "row-1" } } }] }] }
	const page = await mountComponent("../../src/documents/shared/TransferItems.vue", { rows: transferItems(doc) })
	try {
		assert.deepEqual(cells(nodes(page.root, (node) => node.tag === "tr")[1], "td").slice(0, 2), ["Marathon", "Red"])
		setLanguage("ta")
		await resolved()
		assert.deepEqual(cells(nodes(page.root, (node) => node.tag === "tr")[1], "td").slice(0, 2), ["மாரத்தான்", "சிவப்பு"])
	} finally { page.close(); network.restore() }
})

test("DC Close preview and dialog split input and output items into template and attributes", async () => {
	const network = stub({ [jobWorkMethods.previewClose]: () => ({ posting_date: "2026-10-31", docstatus: 0,
		items: [{ name: "i1", item: "Marathon-Red", stock_uom: "Kg", remaining_stock_qty: 4, own_value: 100 }],
		outputs: [{ name: "o1", item: "Marathon-Red", input_item: "Cone", goods_received_note: "GRN-1", stock_qty: 4, allocated_value: 100 }] }) })
	const page = await mountComponent("../../src/documents/delivery-challan/CloseDcDialog.vue", { doc: { name: "DC-1" } })
	try {
		assert.deepEqual(closeItemRows({ items: [{ ...variantRow, input_item: "Cone" }] }).map((row) => [row.item, row["attribute:Colour"], row.input_item]), [["Marathon", "Red", "Cone"]])
		const stored = { doc: { outputs: [{ item: "Marathon-Red", input_item: "Cone" }] }, items: [{ ...variantRow, input_item: "Cone" }] }
		assert.deepEqual(closeItemRows(stored).map((row) => [row.item, row["attribute:Colour"]]), [["Marathon", "Red"]])
		nodes(page.root, (node) => node.tag === "dialog")[0].props.onShow()
		await resolved()
		const tables = nodes(page.root, (node) => node.tag === "table")
		assert.deepEqual(cells(tables[0], "th").slice(0, 3), ["Input Item", "Colour", "UOM"])
		assert.deepEqual(cells(tables[0], "td").slice(0, 2), ["Marathon", "Red"])
		assert.deepEqual(cells(tables[1], "th").slice(0, 3), ["Output Item", "Colour", "Input Item"])
		setLanguage("ta")
		await resolved()
		assert.deepEqual(cells(nodes(page.root, (node) => node.tag === "table")[0], "td").slice(0, 2), ["மாரத்தான்", "சிவப்பு"])
	} finally { page.close(); network.restore() }
})

test("Stock shows the template with one column per attribute, in Tamil too", async () => {
	const network = stub({ "mgk_yrp.web.stock_note.get_stock_note": () => ({
		rows: [{ ...variantRow, warehouse: "WH", warehouse_name: "WH", stock_uom: "Kg", bal_qty: 2, bal_val: 10 },
			{ ...plainRow, warehouse: "WH", warehouse_name: "WH", stock_uom: "Kg", bal_qty: 1, bal_val: 5 }],
		summary: { line_count: 2, warehouse_count: 1, total_value: 15, uom_totals: { Kg: 3 } },
		options: { suppliers: [], warehouses: [], items: [], received_types: [] } }) })
	const page = await mountComponent("../../src/books/stock/StockListPage.vue", {})
	const table = () => nodes(page.root, (node) => node.tag === "table")[0]
	const firstCells = () => nodes(table(), (node) => node.tag === "tr").slice(1).map((tr) => cells(tr, "td").slice(0, 2))
	try {
		await resolved()
		assert.deepEqual(cells(table(), "th").slice(0, 3), ["Item", "Colour", "Supplier"])
		assert.deepEqual(firstCells(), [["MarathonMarathon", "Red"], ["ConeCone", "—"]])
		assert.ok(!textContent(table()).includes("Marathon-Red"))
		setLanguage("ta")
		await resolved()
		assert.deepEqual(firstCells()[0], ["மாரத்தான்Marathon", "சிவப்பு"])
	} finally { page.close(); network.restore() }
})
