import test from "node:test"
import assert from "node:assert/strict"
import { mountComponent, textContent, settle } from "./helpers/component.js"
import { clearReadCaches } from "../src/api/client.js"
import { displayName, fieldDisplayName, setLanguage, tamilNamesSettled } from "../src/shell/displayLanguage.js"
import { formatFieldValue } from "../src/document/fieldDisplay.js"
import { recordParty } from "../src/list/useSplitSelection.js"
import { filterLabel } from "../src/list/clickFilters.js"
import * as purchaseOrder from "../src/documents/purchase-order/presentation.js"
import * as purchaseOrderPreview from "../src/documents/purchase-order/preview.js"
import * as receiptPreview from "../src/documents/goods-received-note/preview.js"

const masters = {
	Supplier: [{ name: "MGK Main", mgk_tamil_name: "எம்ஜிகே மெயின்", supplier_name: "MGK Main" },
		{ name: "Buying Supplier", mgk_tamil_name: "வாங்கும் சப்ளையர்", supplier_name: "Buying Supplier" },
		{ name: "No Tamil", mgk_tamil_name: "", supplier_name: "No Tamil Mills" }],
	Warehouse: [{ name: "Stores - MGK", mgk_tamil_name: "கிடங்கு", warehouse_name: "Stores" }],
	"MGK Agent": [{ name: "AGT-1", mgk_tamil_name: "முகவர்", agent_name: "Agent One" }],
	Item: [{ name: "Yarn 30's", mgk_tamil_name: "நூல் 30", item_name: "Yarn 30's", variant_of: null },
		{ name: "Yarn 30's-Grey", mgk_tamil_name: "", item_name: "Yarn 30's-Grey", variant_of: "Yarn 30's" }],
}

function stubLists() {
	const calls = []
	const original = globalThis.fetch
	globalThis.fetch = async (url) => {
		const params = new URL(String(url), "http://x").searchParams
		let message = []
		if (String(url).includes("frappe.client.get_list")) {
			const doctype = params.get("doctype")
			const names = JSON.parse(params.get("filters"))[0][2]
			calls.push({ doctype, names, fields: JSON.parse(params.get("fields")) })
			message = (masters[doctype] || []).filter((row) => names.includes(row.name))
		}
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	return { calls, restore() { globalThis.fetch = original; clearReadCaches(); setLanguage("en") } }
}

async function resolved() { await tamilNamesSettled(); await settle() }

test("English mode shows the caller's label and makes no lookup", async () => {
	const stub = stubLists()
	try {
		setLanguage("en")
		assert.equal(displayName("Supplier", "MGK Main"), "MGK Main")
		assert.equal(displayName("Supplier", "MGK Main", "MGK Main Ltd"), "MGK Main Ltd")
		await resolved()
		assert.equal(stub.calls.length, 0)
	} finally { stub.restore() }
})

test("Tamil lookups are batched into one get_list per doctype and cached", async () => {
	const stub = stubLists()
	try {
		setLanguage("ta")
		for (const name of ["MGK Main", "Buying Supplier", "No Tamil", "MGK Main"]) displayName("Supplier", name)
		displayName("Warehouse", "Stores - MGK")
		displayName("MGK Agent", "AGT-1")
		displayName("Address", "Somewhere")
		await resolved()
		assert.deepEqual(stub.calls.map((call) => call.doctype).sort(), ["MGK Agent", "Supplier", "Warehouse"])
		assert.deepEqual(stub.calls.find((call) => call.doctype === "Supplier").names, ["MGK Main", "Buying Supplier", "No Tamil"])
		assert.ok(stub.calls.every((call) => call.fields.includes("mgk_tamil_name")))
		assert.equal(displayName("Supplier", "MGK Main"), "எம்ஜிகே மெயின்")
		assert.equal(displayName("Supplier", "No Tamil"), "No Tamil Mills", "falls back to the English title")
		assert.equal(displayName("Warehouse", "Stores - MGK"), "கிடங்கு")
		assert.equal(fieldDisplayName("mgk_agent", "AGT-1"), "முகவர்")
		assert.equal(displayName("Address", "Somewhere"), "Somewhere")
		displayName("Supplier", "Buying Supplier")
		await resolved()
		assert.equal(stub.calls.length, 3, "cached names are not fetched again")
	} finally { stub.restore() }
})

test("an item variant shows its template's Tamil name with the English variant suffix", async () => {
	const stub = stubLists()
	try {
		setLanguage("ta")
		displayName("Item", "Yarn 30's-Grey")
		await resolved()
		assert.equal(displayName("Item", "Yarn 30's-Grey"), "நூல் 30-Grey")
		assert.ok(stub.calls[0].fields.includes("variant_of"))
	} finally { stub.restore() }
})

test("read-only values, summaries, previews, list parties and filters switch with the toggle", async () => {
	const stub = stubLists()
	const doc = { name: "MGK-PO-26-00001", docstatus: 1, supplier: "Buying Supplier", delivery_location: "MGK Main",
		warehouse: "Stores - MGK", mgk_agent: "AGT-1", items: [] }
	const preview = { doc, items: [{ item: "Yarn 30's-Grey", received_type: "Fresh", qty: 1 }] }
	try {
		setLanguage("ta")
		const read = () => ({
			facts: Object.fromEntries(purchaseOrder.viewFacts(doc).map((fact) => [fact.label, fact.value])),
			summary: Object.fromEntries(purchaseOrder.summary(doc).lines.map((line) => [line.label, line.value])),
			previewFacts: Object.fromEntries(purchaseOrderPreview.facts(doc, preview).map((fact) => [fact.label, fact.value])),
			poItem: purchaseOrderPreview.itemRows(preview)[0].item, grnItem: receiptPreview.itemRows(preview)[0].item,
			field: formatFieldValue({ fieldtype: "Link", options: "Supplier" }, "MGK Main"), party: recordParty("MGK Purchase Order", doc),
			filter: filterLabel(["supplier", "=", "MGK Main"], [{ fieldname: "supplier", label: "Supplier", fieldtype: "Link", options: "Supplier" }]),
		})
		read()
		await resolved()
		await resolved()
		const tamil = read()
		assert.equal(tamil.facts.Supplier, "வாங்கும் சப்ளையர்")
		assert.equal(tamil.facts["Delivery location"], "எம்ஜிகே மெயின்")
		assert.equal(tamil.facts.Warehouse, "கிடங்கு")
		assert.equal(tamil.facts["MGK Agent"], "முகவர்")
		assert.equal(tamil.summary.Supplier, "வாங்கும் சப்ளையர்")
		assert.equal(tamil.summary["Delivery to"], "எம்ஜிகே மெயின்")
		assert.equal(tamil.previewFacts["Deliver To"], "எம்ஜிகே மெயின் / கிடங்கு")
		assert.equal(tamil.poItem, "நூல் 30-Grey · Fresh")
		assert.equal(tamil.grnItem, "நூல் 30-Grey")
		assert.equal(tamil.field, "எம்ஜிகே மெயின்")
		assert.equal(tamil.party, "வாங்கும் சப்ளையர்")
		assert.equal(tamil.filter, "Supplier = எம்ஜிகே மெயின்")
		setLanguage("en")
		const english = read()
		assert.equal(english.facts.Supplier, "Buying Supplier")
		assert.equal(english.summary["Delivery to"], "MGK Main")
		assert.equal(english.poItem, "Yarn 30's-Grey · Fresh")
		assert.equal(english.party, "Buying Supplier")
	} finally { stub.restore() }
})

test("the document header title re-renders live when the language toggles", async () => {
	const stub = stubLists()
	const page = await mountComponent("../../src/document/DocumentHeader.vue", {
		book: { cover: "cover-po", code: "PO", label: "Purchase Order" }, doc: { name: "MGK-PO-26-00001", docstatus: 1, supplier: "Buying Supplier" },
	})
	try {
		assert.match(textContent(page.root), /MGK-PO-26-00001 · Buying Supplier/)
		setLanguage("ta")
		await resolved()
		assert.match(textContent(page.root), /MGK-PO-26-00001 · வாங்கும் சப்ளையர்/)
		setLanguage("en")
		await settle()
		assert.match(textContent(page.root), /MGK-PO-26-00001 · Buying Supplier/)
	} finally { page.close(); stub.restore() }
})
