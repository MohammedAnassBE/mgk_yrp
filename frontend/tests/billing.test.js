import test from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"
import { rateChanged, invoiceTotals, invoiceChanges, flt, canGetGrns, groupGrnRows, groupItemRows, setGroupRate, grnSummaries } from "../src/documents/purchase-invoice/fieldEvents.js"
import { createGrnFlow, noGrnsMessage } from "../src/documents/purchase-invoice/grnFlow.js"
import { summary, viewFacts } from "../src/documents/purchase-invoice/presentation.js"
import { canAmendDocument } from "../src/document/lifecycle.js"

const document = () => ({ doctype: "MGK Purchase Invoice", docstatus: 0, supplier: "Vendor", against: "Job Work", bill_no: "B-1", items: [] })

test("Billing rate and totals match the actual Desk handlers, including half cents and configured rounding", async () => {
	const source = await readFile(new URL("../../../frappe/frappe/public/js/frappe/utils/number_format.js", import.meta.url), "utf8")
	const rounding = source.slice(source.indexOf("function _round("), source.indexOf("function roundNumber("))
	const handlers = {}
	const context = vm.createContext({ frappe: { boot: { sysdefaults: {} }, ui: { form: { on: (name, events) => { handlers[name] = events } } } },
		cint: (value) => parseInt(value) || 0, flt: (value, precision) => precision == null ? Number(value) || 0 : context._round(Number(value) || 0, precision) })
	vm.runInContext(rounding, context)
	vm.runInContext(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_purchase_invoice/mgk_purchase_invoice.js", import.meta.url), "utf8"), context)
	for (const method of ["Banker's Rounding (legacy)", "Banker's Rounding", "Commercial Rounding"]) {
		context.frappe.boot.sysdefaults.rounding_method = method
		for (const value of [0, 1.005, 1.015, 2.225, -1.005, 0.0049, 999.995]) assert.equal(flt(value, 2, method), context._round(value, 2), `${method} ${value}`)
	}
	for (const tax_type of ["CGST + SGST", "IGST", "No Tax"]) {
		context.frappe.boot.sysdefaults.rounding_method = "Banker's Rounding (legacy)"
		const rows = [{ qty: 3, rate: 10.005, gst_rate: 18 }, { qty: 1, rate: 1.005, gst_rate: 5 }, { qty: 2.3, rate: 8.155, gst_rate: 0 }]
		const expected = structuredClone(rows)
		context.locals = { Row: Object.fromEntries(expected.map((row, index) => [index, row])) }
		const frm = { doc: { items: expected, tax_type }, refresh_field: () => {}, set_value: (values) => Object.assign(frm.doc, values) }
		for (const index of expected.keys()) handlers["MGK Purchase Invoice Item"].rate(frm, "Row", index)
		for (const row of rows) rateChanged(row, tax_type)
		assert.deepEqual(rows, expected)
		for (const [field, value] of Object.entries(invoiceTotals(rows))) assert.equal(value, frm.doc[field], `${tax_type} ${field}`)
	}
	assert.equal(rateChanged({ qty: 3, rate: 10.005, gst_rate: 18 }, "CGST + SGST").cgst_amount, 2.7)
})

test("Billing source changes reset rows, GSTINs, tax type and every total, while submitted snapshots stay intact", () => {
	for (const name of ["supplier", "against"]) {
		const changes = invoiceChanges(name, document())
		assert.deepEqual(changes.items, [])
		assert.equal(changes.supplier_gstin, "")
		assert.equal(changes.company_gstin, "")
		assert.equal(changes.tax_type, "No Tax")
		for (const field of Object.keys(invoiceTotals([]))) assert.equal(changes[field], 0)
		assert.deepEqual(invoiceChanges(name, { ...document(), docstatus: 1 }), {})
	}
	const doc = { ...document(), tax_type: "IGST", items: [{ qty: 2, rate: 10, gst_rate: 18, cgst_amount: 4 }] }
	assert.equal(invoiceChanges("items", doc).grand_total, 23.6)
	assert.equal(doc.items[0].cgst_amount, 0)
})

function flowContext(call, callDoc = async (doc) => ({ doc })) {
	let doc = document()
	const messages = [], updates = []
	const flow = createGrnFlow({ getDoc: () => doc, call, callDoc,
		update: (values) => { Object.assign(doc, values); updates.push(values) }, messages: (values) => messages.push(...values) })
	return { flow, get doc() { return doc }, replace: () => { doc = document() }, messages, updates }
}

test("Get GRNs guards draft, supplier, against and selection; empty results show the Desk message", async () => {
	for (const flags of [{ docstatus: 1 }, { docstatus: 2 }, { supplier: "" }, { against: "" }]) assert.equal(canGetGrns({ ...document(), ...flags }), false)
	const page = flowContext(async (method, args) => { assert.ok(method.endsWith("get_unbilled_grns")); assert.deepEqual(args, { supplier: "Vendor", against: "Job Work" }); return [] })
	assert.deepEqual(await page.flow.list(), [])
	assert.deepEqual(page.messages, [noGrnsMessage])
	assert.equal(await page.flow.fetch([]), false)
	page.doc.supplier = ""
	assert.deepEqual(await page.flow.list(), [])
})

test("Get GRNs fetches full rows, previews taxes through the controller, keeps bill fields, and shows server warnings", async () => {
	const calls = []
	const row = { item: "Yarn", qty: 2, rate: 10, goods_received_note: "GRN-1", goods_received_note_item: "row-1", uom: "Kg", conversion_factor: 1 }
	const warning = "No GST charged for these items because they have no MGK GST Tax Slab: Yarn"
	const page = flowContext(async (method, args) => {
		calls.push({ method, args })
		return method.endsWith("get_unbilled_grns") ? [{ name: "GRN-1", posting_date: "2026-10-29", total_qty: 2 }] : [row]
	}, async (doc, method) => {
		assert.equal(method, "preview_taxes")
		assert.deepEqual(doc.items, [row])
		return { doc: { ...doc, tax_type: "IGST", supplier_gstin: "33GST", items: [{ ...row, amount: 20, gst_rate: 0 }], ...invoiceTotals([{ ...row, amount: 20 }]) }, messages: [warning] }
	})
	await page.flow.list()
	assert.equal(await page.flow.fetch(["GRN-1"]), true)
	assert.deepEqual(calls[1].args, { grn_names: ["GRN-1"] })
	assert.equal(page.doc.grand_total, 20)
	assert.equal(page.doc.bill_no, "B-1")
	assert.equal(page.doc.items[0].goods_received_note_item, "row-1")
	assert.deepEqual(page.messages, [warning])
	assert.equal(page.updates.length, 2)
})

test("Get GRNs drops stale lists, row fetches and previews after party/type/status or document changes", async () => {
	for (const phase of ["list", "rows", "preview"]) for (const mutation of ["supplier", "against", "status", "document"]) {
		let finish
		const pending = new Promise((resolve) => { finish = resolve })
		const page = flowContext(async (method) => {
			if (method.endsWith("get_unbilled_grns")) return phase === "list" ? pending : [{ name: "GRN-1" }]
			return phase === "rows" ? pending : [{ item: "Yarn" }]
		}, async () => pending)
		const request = phase === "list" ? page.flow.list() : (await page.flow.list(), page.flow.fetch(["GRN-1"]))
		await new Promise(setImmediate)
		if (mutation === "document") page.replace()
		else if (mutation === "status") page.doc.docstatus = 1
		else page.doc[mutation] = "Changed"
		const count = page.updates.length
		finish(phase === "preview" ? { doc: { supplier: "Wrong", items: ["stale"] } } : [{ name: "GRN-1" }])
		await request
		assert.equal(page.updates.length, count)
		assert.notEqual(page.doc.supplier, "Wrong")
	}
})

test("Get GRNs refuses injected selections and leaves rows available after a failed tax preview", async () => {
	const page = flowContext(async (method) => method.endsWith("get_unbilled_grns") ? [{ name: "GRN-1" }] : [{ item: "Yarn" }], async () => { throw new Error("Company GSTIN is required.") })
	await page.flow.list()
	await assert.rejects(page.flow.fetch(["Other"]), /displayed list/)
	await assert.rejects(page.flow.fetch(["GRN-1"]), /Company GSTIN/)
	assert.deepEqual(page.doc.items, [{ item: "Yarn" }])
})

test("bill summary/facts contain paper and GST totals, GRN grouping preserves source order and row indices, Amend waits for valuation", () => {
	const doc = { ...document(), bill_date: "2026-10-29", tax_type: "IGST", net_total: 20, total_igst: 3.6, grand_total: 23.6 }
	assert.equal(summary(doc).lines.at(-1).value, 23.6)
	assert.ok(viewFacts(doc).some((fact) => fact.label === "Bill No" && fact.value === "B-1"))
	const rows = [{ goods_received_note: "GRN-1" }, { goods_received_note: "GRN-2" }, { goods_received_note: "GRN-1" }]
	assert.deepEqual(groupGrnRows(rows).map((group) => [group.name, group.rows.map((entry) => entry.index)]), [["GRN-1", [0, 2]], ["GRN-2", [1]]])
	assert.equal(canAmendDocument({ docstatus: 2, __onload: { valuation_pending: true } }, () => true), false)
	assert.equal(canAmendDocument({ docstatus: 2, __onload: { valuation_pending: false } }, () => true), true)
	assert.equal(canAmendDocument({ docstatus: 2 }, () => false), false)
})

test("Billing groups items by item + GRN rate across GRNs, sums qty/amount, shows the first bill rate and a group rate edit sets every row", () => {
	const rows = [
		{ item: "Yarn", uom: "Kg", qty: 2, grn_rate: 10, rate: 10, amount: 20, goods_received_note: "GRN-1" },
		{ item: "Yarn", uom: "Kg", qty: 3, grn_rate: 12, rate: 12, amount: 36, goods_received_note: "GRN-1" },
		{ item: "Yarn", uom: "Kg", qty: 4, grn_rate: 10, rate: 11, amount: 44, goods_received_note: "GRN-2" },
	]
	const groups = groupItemRows(rows)
	assert.deepEqual(groups.map((group) => [group.item, group.grn_rate, group.qty, group.amount, group.rate, group.indices]), [["Yarn", 10, 6, 64, 10, [0, 2]], ["Yarn", 12, 3, 36, 12, [1]]])
	const edited = setGroupRate(rows, groups[0].indices, 15)
	assert.deepEqual(edited.map((row) => row.rate), [15, 12, 15])
	const doc = { docstatus: 0, tax_type: "CGST + SGST", items: edited.map((row) => ({ ...row, gst_rate: 5 })) }
	const totals = invoiceChanges("items", doc)
	assert.deepEqual(doc.items.map((row) => [row.amount, row.cgst_amount]), [[30, 0.75], [36, 0.9], [60, 1.5]])
	assert.equal(totals.net_total, 126)
	assert.deepEqual(grnSummaries(groupGrnRows(rows), { "GRN-1": "2026-10-29" }), [
		{ name: "GRN-1", posting_date: "2026-10-29", total_qty: 5, total_amount: 56 }, { name: "GRN-2", posting_date: "", total_qty: 4, total_amount: 40 }])
})
