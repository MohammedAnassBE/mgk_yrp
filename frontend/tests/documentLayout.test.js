import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { connectedDocuments, documentLayout, summaryFields, statusFields, detailCompanionFields } from "../src/document/documentLayout.js"
import { companionText } from "../src/document/fieldDisplay.js"
import { tableFields } from "../src/document/fields/tableFields.js"

test("all five layouts keep paper order and omit duplicate, computed and display-only panel rows", async () => {
	const paper = {
		"MGK Purchase Order": ["supplier", "item_group", "po_date", "deliver_to_supplier", "delivery_location", "warehouse", "process_name", "mgk_agent"],
		"MGK Goods Received Note": ["supplier", "purchase_order", "process_name", "delivery_location", "warehouse", "posting_date"],
		"MGK Delivery Challan": ["from_location", "from_warehouse", "to_location", "to_warehouse", "process_name", "posting_date"],
		"MGK Purchase Invoice": ["supplier", "bill_no", "bill_date"],
		"MGK Delivery Challan Close": ["delivery_challan", "posting_date", "supplier", "warehouse"],
	}
	for (const [doctype, names] of Object.entries(paper)) {
		const name = doctype.toLowerCase().replaceAll(" ", "_")
		const meta = JSON.parse(await readFile(new URL(`../../mgk_yrp/mgk_yrp/doctype/${name}/${name}.json`, import.meta.url)))
		const layout = documentLayout(doctype, meta)
		assert.deepEqual(layout.paper.map((field) => field.fieldname), names)
		const placed = [...layout.paper, ...layout.panel].map((field) => field.fieldname)
		assert.equal(placed.length, new Set(placed).size)
		const excluded = [...summaryFields, ...statusFields, ...Object.values(detailCompanionFields).flat(), "items", "outputs", "item_html", "item_details", "purchase_invoice", "delivery_challan_close"]
		if (doctype === "MGK Delivery Challan") excluded.push("is_return")
		for (const field of meta.fields) assert.equal(placed.includes(field.fieldname), !excluded.includes(field.fieldname), `${doctype}: ${field.fieldname}`)
	}
})

test("DC Close output valuation columns use real read-only fields and reach the table renderer", async () => {
	const name = "mgk_delivery_challan_close_output"
	const meta = JSON.parse(await readFile(new URL(`../../mgk_yrp/mgk_yrp/doctype/${name}/${name}.json`, import.meta.url)))
	const layout = documentLayout("MGK Delivery Challan Close", { fields: [] })
	const parent = { doctype: "MGK Delivery Challan Close", docstatus: 1 }
	const rendered = tableFields(meta, { fieldname: "outputs" }, parent, { ...meta, permissions: [] }, {}, { name: "Administrator" })
	assert.deepEqual(rendered.map((field) => field.fieldname), layout.outputColumns)
	for (const name of ["input_item", "allocation_weight", "allocated_value", "allocated_rate"]) {
		assert.equal(rendered.find((field) => field.fieldname === name)?.read_only, 1, name)
	}
})

test("address and contact details stay beneath their owning link value as plain text", () => {
	const doc = { address_display: "Main Road<br>Chennai", contact_display: "<b>Asha</b>", contact_mobile: "9876543210" }
	assert.equal(companionText({ fieldname: "supplier_address" }, doc), "Main Road\nChennai")
	assert.equal(companionText({ fieldname: "contact_person" }, doc), "Asha\n9876543210")
	assert.equal(companionText({ fieldname: "warehouse" }, doc), "")
})

test("PO, GRN and DC provide read-only item helper copy", () => {
	for (const [doctype, help] of Object.entries({ "MGK Purchase Order": "Items recorded in this order.",
		"MGK Goods Received Note": "Quantities received in this note.", "MGK Delivery Challan": "Quantities dispatched in this challan." })) {
		assert.equal(documentLayout(doctype, { fields: [] }).readOnlyHelp, help)
	}
})

test("saved side cards link present source documents, including DC Close and amendments", () => {
	const meta = { fields: [{ fieldname: "purchase_order", fieldtype: "Link", options: "MGK Purchase Order" }, { fieldname: "delivery_challan_close", fieldtype: "Link", options: "MGK Delivery Challan Close" }, { fieldname: "amended_from", fieldtype: "Link", options: "MGK Delivery Challan" }] }
	const links = connectedDocuments({ purchase_order: "PO / 1", delivery_challan_close: "Close-1", amended_from: "DC-1" }, meta)
	assert.deepEqual(links.map((link) => link.to), ["/purchase-order/PO%20%2F%201", "/delivery-challan-close/Close-1", "/delivery-challan/DC-1"])
})

test("PO form shows Item Group next to Supplier and hides the derived order flags", async () => {
	const { default: layout } = await import("../src/documents/purchase-order/layout.js")
	assert.deepEqual(layout.paperFields.slice(0, 2), ["supplier", "item_group"])
	const doctype = JSON.parse(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_purchase_order/mgk_purchase_order.json", import.meta.url)))
	const byName = Object.fromEntries(doctype.fields.map((field) => [field.fieldname, field]))
	assert.deepEqual([byName.item_group.fieldtype, byName.item_group.options, byName.item_group.reqd], ["Link", "Item Group", undefined])
	assert.equal(doctype.field_order.indexOf("item_group"), doctype.field_order.indexOf("supplier") + 1)
	for (const flag of ["is_karigan_order", "is_salavai_cone_order"]) {
		assert.equal(layout.panelFields.includes(flag), false)
		assert.deepEqual([byName[flag].read_only, byName[flag].hidden], [1, 1])
	}
})
