import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import * as purchaseOrder from "../src/documents/purchase-order/preview.js"
import * as receipt from "../src/documents/goods-received-note/preview.js"
import * as challan from "../src/documents/delivery-challan/preview.js"
import * as billing from "../src/documents/purchase-invoice/preview.js"
import * as close from "../src/documents/delivery-challan-close/preview.js"

const modules = [purchaseOrder, receipt, challan, billing, close]
const values = (module, doc, preview) => Object.fromEntries(module.facts(doc, preview).map((fact) => [fact.label, fact.value]))
const schema = async (name) => JSON.parse(await readFile(new URL(`../../mgk_yrp/mgk_yrp/doctype/${name}/${name}.json`, import.meta.url), "utf8"))

test("all preview modules handle missing extras and empty documents without mutating the response", () => {
	for (const module of modules) {
		assert.ok(module.facts({}).length > 0)
		assert.deepEqual(module.itemRows({ doc: {} }), [])
		assert.equal(module.progress({}, { doc: {} }), null)
		const preview = { doc: {}, items: [{ item: "Yarn", qty: 0, amount: 0 }] }
		const original = structuredClone(preview)
		for (const row of module.itemRows(preview)) {
			for (const column of module.itemColumns) assert.ok(Object.hasOwn(row, column.key), column.key)
		}
		module.facts(preview.doc, preview)
		assert.deepEqual(preview, original)
	}
})

test("PO deliver-to-supplier facts include Process, stored pending quantity and receipt progress", () => {
	const doc = { supplier: "Mill", po_date: "2026-10-30", delivery_location: "Worker", warehouse: "Worker Stock",
		deliver_to_supplier: "1", process_name: "Dyeing", goods_routing: "Direct", total_amount: 200,
		items: [{ item: "Yarn", received_type: "Fresh", qty: 10, received_qty: 4, pending_qty: 6, rate: 20, amount: 200 }] }
	const facts = values(purchaseOrder, doc)
	assert.equal(facts.Process, "Dyeing")
	assert.equal(facts["Deliver to Supplier"], "Yes")
	assert.equal(facts["Deliver To"], "Worker / Worker Stock")
	assert.equal(facts["Pending qty"], 6)
	assert.equal(facts.Amount, "200.00")
	assert.deepEqual(purchaseOrder.progress(doc), { label: "Received / ordered", value: 4, max: 10 })
	assert.equal(purchaseOrder.itemRows({ doc })[0].item, "Yarn · Fresh")
	assert.equal(values(purchaseOrder, { ...doc, deliver_to_supplier: "0" }).Process, undefined)
	for (const [flags, expected] of [[{}, "Regular"], [{ is_karigan_order: 1 }, "Karigan"], [{ is_salavai_cone_order: 1 }, "Salavai Cone"]]) {
		assert.equal(values(purchaseOrder, flags)["Order Type"], expected)
	}
})

test("GRN facts distinguish PO, job work and internal transfer and use web document links", () => {
	const doc = { docstatus: 1, against_purchase_order: 1, purchase_order: "PO / 1", purchase_invoice: "PI / 1", purchase_invoice_docstatus: 1 }
	assert.equal(values(receipt, doc).Against, "Purchase Order")
	assert.equal(values(receipt, doc)["Bill status"], "Billed")
	assert.equal(receipt.facts(doc).find((fact) => fact.label === "Purchase Order").to, "/purchase-order/PO%20%2F%201")
	assert.equal(receipt.facts(doc).find((fact) => fact.label === "Bill status").to, "/billing/PI%20%2F%201")
	const job = { docstatus: 1, against_purchase_order: 0, delivery_challans: [{ delivery_challan: "DC / 1" }] }
	assert.equal(values(receipt, job).Against, "Job Work")
	assert.equal(receipt.facts(job).find((fact) => fact.label === "DC").to, "/delivery-challan/DC%20%2F%201")
	const internal = { ...job, is_internal_transfer: "1", transfer_status: "Partly Transferred" }
	assert.equal(values(receipt, internal).Against, "Internal transfer")
	assert.equal(values(receipt, internal)["Transfer status"], "Partly Transferred")
	assert.equal(values(receipt, job)["Transfer status"], undefined)
	assert.equal(receipt.itemRows({ doc: internal, items: [{ qty: 7, transferred_qty: 0 }] })[0].transferred_qty, 0)
	assert.equal(receipt.itemRows({ doc: job, items: [{ transferred_qty: 4 }] })[0].transferred_qty, null)
	assert.equal(receipt.facts({}).find((fact) => fact.label === "Bill status").to, undefined)
})

test("DC facts link source and close documents while Plan remains read-only text", () => {
	const doc = { from_location: "Mill", to_location: "Worker", process_name: "Dyeing", purchase_order: "PO / 1",
		goods_received_note: "GRN / 1", return_against: "DC / 1", mgk_process_planning: "Plan-1", delivery_challan_close: "Close / 1", close_status: "Closed" }
	const facts = challan.facts(doc)
	assert.equal(values(challan, doc)["From → To"], "Mill → Worker")
	assert.equal(values(challan, { ...doc, is_internal_transfer: 1 }).Process, "Internal transfer")
	assert.equal(facts.find((fact) => fact.label === "Plan").to, undefined)
	assert.equal(facts.find((fact) => fact.label === "GRN source").to, "/goods-received-note/GRN%20%2F%201")
	assert.equal(facts.find((fact) => fact.label === "Close status").to, "/delivery-challan-close/Close%20%2F%201")
	assert.equal(facts.find((fact) => fact.label === "Return Against").to, "/delivery-challan/DC%20%2F%201")
	const row = challan.itemRows({ doc: { is_internal_transfer: 1 }, items: [{ qty: 10, transferred_qty: 3, returned_qty: 4, conversion_factor: 2 }] })[0]
	assert.equal(row.transferred_qty, 3)
	assert.equal(row.returned_qty, 4)
	assert.equal(row.pending_in_transit, 5)
	for (const key of ["received_back", "out"]) assert.equal(Object.hasOwn(row, key), false)
	assert.equal(values(challan, doc)["Still Out"], undefined)
})

test("DC transit columns are internal-only and preview intros reuse document transit quantities", () => {
	assert.deepEqual(challan.itemColumns.filter((column) => column.internalOnly).map((column) => column.key),
		["transferred_qty", "returned_qty", "pending_in_transit"])
	for (const module of [challan, receipt]) {
		const doc = { docstatus: 1, is_internal_transfer: 1 }
		const items = [{ item: "Yarn", qty: 10, transferred_qty: 3, returned_qty: 4, conversion_factor: 2, uom: "Kg" }]
		assert.equal(module.intro({ doc, items }), "Pending in transit: Yarn 5 Kg")
		assert.equal(module.intro({ doc: { ...doc, items } }), "Pending in transit: Yarn 5 Kg")
		for (const flags of [{ docstatus: 0 }, { is_internal_transfer: 0 }]) assert.equal(module.intro({ doc: { ...doc, ...flags }, items }), null)
		assert.equal(module.intro({ doc, items: [{ ...items[0], transferred_qty: 8 }] }), null)
		assert.equal(module.intro({}), null)
	}
})

test("DC plan rows form a second read-only table and absent extra is empty", () => {
	assert.deepEqual(challan.planRows({}), [])
	assert.deepEqual(challan.planRows({ extra: {} }), [])
	const rows = [{ item: "Dyed Yarn", received_type: "Fresh", qty: 10, uom: "Kg" }]
	assert.deepEqual(challan.planRows({ extra: { plan_rows: rows } }), rows)
	assert.deepEqual(challan.planColumns.map((column) => column.key), ["item", "received_type", "qty", "uom"])
})

test("Billing uses invoice totals and GRN child fields", () => {
	const doc = { supplier: "Worker", against: "Job Work", posting_date: "2026-10-30", bill_no: "Bill 7", bill_date: "2026-10-29",
		tax_type: "IGST", net_total: 100, grand_total: 118 }
	assert.deepEqual(values(billing, doc), { Supplier: "Worker", Against: "Job Work", "Posting Date": "2026-10-30",
		"Bill No": "Bill 7", "Bill Date": "2026-10-29", "Tax Type": "IGST", "Net Total": "100.00", "Grand Total": "118.00" })
	const row = { item: "Yarn", goods_received_note: "GRN-1", qty: 5, rate: 20, amount: 100 }
	assert.deepEqual(billing.itemRows({ items: [row] }), [row])
})

test("DC Close previews outputs and stored allocation values, not delivered input items", () => {
	const output = { item: "Cloth", input_item: "Yarn", goods_received_note: "GRN-1", stock_qty: 2,
		allocation_weight: 3.5, allocated_value: 70, allocated_rate: 35 }
	const doc = { delivery_challan: "DC / 1", total_dc_value: 70, total_output_qty: 2, value_per_unit: 35, loss_value: 0,
		reopen_status: "Reopened", outputs: [output] }
	assert.deepEqual(close.itemRows({ doc, items: [{ item: "Yarn" }] }), [output])
	assert.deepEqual(close.itemRows({ items: [output] }), [output])
	assert.equal(close.facts(doc)[0].to, "/delivery-challan/DC%20%2F%201")
	assert.equal(values(close, doc)["Loss Value"], "0.00")
	assert.equal(values(close, doc)["Reopen status"], "Reopened")
})

test("preview columns use verified child schema fields and shared pending transit calculation", async () => {
	const children = [[purchaseOrder, "mgk_purchase_order_item"], [receipt, "mgk_goods_received_note_item"],
		[challan, "mgk_delivery_challan_item"], [billing, "mgk_purchase_invoice_item"], [close, "mgk_delivery_challan_close_output"]]
	for (const [module, name] of children) {
		const fields = new Set((await schema(name)).fields.map((field) => field.fieldname))
		fields.add("received_type")
		if (module === challan) fields.add("pending_in_transit")
		for (const column of module.itemColumns) assert.ok(fields.has(column.key), `${name}: ${column.key}`)
	}
	const fields = new Set((await schema("mgk_process_planning_item")).fields.map((field) => field.fieldname))
	for (const column of challan.planColumns) assert.ok(fields.has(column.key) || column.key === "received_type")
	const dimensions = await readFile(new URL("../../mgk_yrp/stock/dimension_fields.py", import.meta.url), "utf8")
	assert.ok(dimensions.includes('"MGK Process Planning Item"'))
})
