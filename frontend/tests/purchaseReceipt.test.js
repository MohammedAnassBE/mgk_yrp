import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { purchaseOrderChanges, createFieldEvents as purchaseOrderEvents } from "../src/documents/purchase-order/fieldEvents.js"
import { goodsReceivedNoteChanges, createFieldEvents as receiptEvents, purchaseOrderFilters, makeGoodsReceivedNote } from "../src/documents/goods-received-note/fieldEvents.js"
import { documentModule } from "../src/documents/registry.js"
import { documentLayout } from "../src/document/documentLayout.js"
import { fieldState } from "../src/document/fieldConditions.js"
import { fieldQuery } from "../src/document/fieldQueries.js"
import { openMappedDraft, readMappedDraft, amendmentDraft } from "../src/document/mappedDraft.js"
import { metaDefaults } from "../src/document/newDocDefaults.js"
import { addEntry, editorSavePayload, loadItems } from "../src/item-editor/editorPayload.js"
import { preparePurchaseOrderEntry, recalculate } from "../src/item-editor/editorModes.js"
import { routeFilters } from "../src/list/routeFilters.js"

function deferred() {
	let resolve, reject
	const promise = new Promise((done, fail) => { resolve = done; reject = fail })
	return { promise, resolve, reject }
}
function itemDetails() {
	return [{ attributes: [], primary_attribute: "", primary_attribute_values: [], items: [{ name: "Yarn", attributes: {},
		dimensions: { received_type: "Accepted" }, default_uom: "Kg", values: { default: {
			qty: 10, rate: 5, purchase_order_item: "po-row", uom: "Kg", stock_uom: "Kg", conversion_factor: 1, pending_qty: 10, allowed_qty: 10,
		} } }] }]
}
function mappedReceipt(supplier = "Vendor") {
	return { doctype: "MGK Goods Received Note", against_purchase_order: 1, purchase_order: "PO-1", supplier,
		process_name: "Dyeing",
		delivery_location: "Own", warehouse: "Main", total_qty: 10, total_amount: 50, __onload: { item_details: itemDetails() } }
}

test("PO field changes clear supplier companions, warehouse, direct handling and exclusive flags", () => {
	assert.deepEqual(purchaseOrderChanges("supplier", {}), {
		supplier_address: "", address_display: "", contact_person: "", contact_display: "", contact_mobile: "",
	})
	assert.deepEqual(purchaseOrderChanges("delivery_location", {}), { warehouse: "" })
	assert.deepEqual(purchaseOrderChanges("goods_routing", { goods_routing: "Direct" }), { handling_supplier: "" })
	assert.deepEqual(purchaseOrderChanges("goods_routing", { goods_routing: "Through Vendor" }), {})
	assert.deepEqual(purchaseOrderChanges("is_karigan_order", { is_karigan_order: 1 }), { is_salavai_cone_order: 0 })
	assert.deepEqual(purchaseOrderChanges("is_salavai_cone_order", { is_salavai_cone_order: 1 }), { is_karigan_order: 0 })
	assert.deepEqual(purchaseOrderChanges("is_karigan_order", { is_karigan_order: 0 }), {})
})

test("PO address/contact display methods use Desk arguments and drop stale responses, including A-B-A", async () => {
	let doc = { supplier: "Vendor", supplier_address: "A", contact_person: "C" }
	const requests = []
	const events = purchaseOrderEvents({ getDoc: () => doc, call: (method, args) => {
		const pending = deferred(); requests.push({ method, args, ...pending }); return pending.promise
	} })
	const oldAddress = events.change("supplier_address")
	doc.supplier_address = "B"
	const secondAddress = events.change("supplier_address")
	doc.supplier_address = "A"
	const latestAddress = events.change("supplier_address")
	requests[2].resolve("Latest address"); await latestAddress
	requests[0].resolve("Old address"); await oldAddress
	requests[1].reject(new Error("Obsolete error")); await secondAddress
	assert.equal(doc.address_display, "Latest address")
	assert.deepEqual(requests[0].args, { address_dict: "A" })
	assert.ok(requests[0].method.endsWith("address.get_address_display"))
	const contact = events.change("contact_person")
	requests[3].resolve({ contact_display: "Asha", contact_mobile: "123" }); await contact
	assert.ok(requests[3].method.endsWith("contact.get_contact_details"))
	assert.deepEqual(requests[3].args, { contact: "C" })
	assert.equal(doc.contact_display, "Asha")
	assert.equal(doc.contact_mobile, "123")
	const obsolete = events.change("contact_person")
	await events.change("supplier")
	requests[4].resolve({ contact_display: "Old contact" }); await obsolete
	assert.equal(doc.contact_display, "")
	doc.contact_person = "C2"
	const failed = events.change("contact_person")
	requests[5].reject(new Error("Permission denied"))
	await assert.rejects(failed, /Permission denied/)
	doc = { supplier_address: "A" }
	const replaced = events.change("supplier_address")
	doc = { supplier_address: "A" }
	requests[6].resolve("Wrong document"); await replaced
	assert.equal(doc.address_display, undefined)
})

test("GRN source toggle clears PO, child rows, cached editor data, DC links and totals", () => {
	for (const against_purchase_order of [0, 1]) {
		const patch = goodsReceivedNoteChanges("against_purchase_order", { against_purchase_order, __onload: { other: "keep" } })
		assert.deepEqual(patch, { process_name: "", items: [], item_details: null, __onload: { other: "keep", item_details: [] },
			total_qty: 0, total_amount: 0, purchase_order: "", delivery_challans: [] })
	}
	assert.deepEqual(goodsReceivedNoteChanges("supplier", {}), { delivery_challans: [] })
	assert.deepEqual(goodsReceivedNoteChanges("delivery_location", {}), { warehouse: "" })
	assert.equal("purchase_order" in goodsReceivedNoteChanges("purchase_order", {}), false)
})

test("GRN PO mapping fills server headers and editor data, including selecting a PO without a supplier", async () => {
	const doc = { against_purchase_order: 1, purchase_order: "PO-1", items: [{ qty: 99 }], total_qty: 99 }
	const result = mappedReceipt()
	const events = receiptEvents({ getDoc: () => doc, call: async (method, args) => {
		assert.equal(method, makeGoodsReceivedNote)
		assert.deepEqual(args, { source_name: "PO-1" })
		assert.deepEqual(doc.items, [])
		assert.equal(doc.total_qty, 0)
		return result
	} })
	await events.change("purchase_order")
	for (const key of ["supplier", "process_name", "delivery_location", "warehouse", "total_qty", "total_amount"]) assert.equal(doc[key], result[key])
	assert.deepEqual(doc.__onload.item_details, result.__onload.item_details)
})

test("GRN PO to job work and cleared PO discard the inherited process", async () => {
	for (const field of ["against_purchase_order", "purchase_order"]) {
		const doc = { against_purchase_order: 1, purchase_order: "PO-1" }
		const events = receiptEvents({ getDoc: () => doc, call: async () => mappedReceipt() })
		await events.change("purchase_order")
		assert.equal(doc.process_name, "Dyeing")
		doc[field] = field === "purchase_order" ? "" : 0
		await events.change(field)
		assert.equal(doc.process_name, "")
	}
	assert.equal("process_name" in goodsReceivedNoteChanges("delivery_challans", { process_name: "Weaving" }), false)
})

test("GRN stale mappings cannot apply after newer PO, toggle, cleared PO or document replacement", async () => {
	for (const invalidate of ["newer", "toggle", "clear", "replace", "same-name"]) {
		let doc = { against_purchase_order: 1, purchase_order: "PO-1" }
		const pending = []
		const events = receiptEvents({ getDoc: () => doc, call: () => { const request = deferred(); pending.push(request); return request.promise } })
		const first = events.change("purchase_order")
		let second
		if (invalidate === "toggle") { doc.against_purchase_order = 0; await events.change("against_purchase_order") }
		if (invalidate === "clear") { doc.purchase_order = ""; await events.change("purchase_order") }
		if (invalidate === "replace") doc = { ...doc }
		if (["newer", "same-name"].includes(invalidate)) {
			doc.purchase_order = invalidate === "newer" ? "PO-2" : "PO-1"
			second = events.change("purchase_order")
			pending[1].resolve(mappedReceipt("New supplier")); await second
		}
		pending[0].resolve(mappedReceipt("Stale supplier")); await first
		assert.notEqual(doc.supplier, "Stale supplier", invalidate)
		if (second) assert.equal(doc.supplier, "New supplier")
	}
})

test("PO and DC pickers use supplier-scoped Desk filters; against-PO party fields are read-only", () => {
	assert.deepEqual(purchaseOrderFilters({ supplier: "Vendor" }), { docstatus: 1, status: ["in", ["To Receive", "Partially Received"]], supplier: "Vendor" })
	assert.equal("supplier" in purchaseOrderFilters({}), false)
	assert.deepEqual(fieldQuery({ fieldname: "delivery_challans" }, { supplier: "Vendor" }).filters,
		{ docstatus: 1, is_return: 0, close_status: "Open", to_location: "Vendor" })
	assert.deepEqual(fieldQuery({ fieldname: "warehouse", options: "Warehouse" }, { delivery_location: "Own" }).filters,
		{ disabled: 0, is_group: 0, supplier: "Own" })
	const meta = { fields: ["supplier", "delivery_location", "process_name"].map((fieldname) => ({ fieldname, fieldtype: "Link" })) }
	const layout = documentLayout("MGK Goods Received Note", meta)
	for (const field of [...layout.paper, ...layout.panel]) {
		assert.equal(fieldState(field, { against_purchase_order: 1 }, meta, { name: "Administrator" }).readOnly, true)
		assert.equal(fieldState(field, { against_purchase_order: 0 }, meta, { name: "Administrator" }).readOnly, false)
	}
})

test("GRN Process is always visible and follows the PO field in the web panel", async () => {
	const meta = JSON.parse(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_goods_received_note/mgk_goods_received_note.json", import.meta.url)))
	const layout = documentLayout("MGK Goods Received Note", meta)
	const process = layout.panel.find((field) => field.fieldname === "process_name")
	assert.equal(process.depends_on, undefined)
	assert.equal(process.read_only_depends_on, "eval:doc.against_purchase_order")
	assert.equal(layout.panel.indexOf(process), layout.panel.findIndex((field) => field.fieldname === "purchase_order") + 1)
	for (const against_purchase_order of [0, 1]) {
		const state = fieldState(process, { against_purchase_order }, meta, { name: "Administrator" })
		assert.equal(state.visible, true)
		assert.equal(state.readOnly, Boolean(against_purchase_order))
	}
})

test("bill dates default to today and GRN posting date/time obey the Desk edit toggle", async () => {
	for (const [doctype, dateField] of [["mgk_purchase_order", "po_date"], ["mgk_goods_received_note", "posting_date"]]) {
		const meta = JSON.parse(await readFile(new URL(`../../mgk_yrp/mgk_yrp/doctype/${doctype}/${doctype}.json`, import.meta.url)))
		const defaults = metaDefaults(meta, new Date(2026, 9, 29, 9, 8, 7))
		assert.equal(defaults[dateField], "2026-10-29")
		if (dateField === "po_date") { assert.equal(defaults.goods_routing, "Direct"); continue }
		assert.equal(defaults.posting_time, "09:08:07")
		for (const name of ["posting_date", "posting_time"]) {
			const field = meta.fields.find((field) => field.fieldname === name)
			assert.equal(fieldState(field, { docstatus: 0, edit_posting_date_and_time: 0 }, meta, { name: "Administrator" }).readOnly, true)
			assert.equal(fieldState(field, { docstatus: 0, edit_posting_date_and_time: 1 }, meta, { name: "Administrator" }).readOnly, false)
		}
	}
})

test("Create GRN is gated by submission, pending quantity and create permission; mapper stages a refreshable UUID draft", async () => {
	const module = documentModule("MGK Purchase Order")
	const doc = { docstatus: 1, items: [{ pending_qty: 1 }] }
	const allow = (doctype, permission) => doctype === "MGK Goods Received Note" && permission === "create"
	const actions = module.actions(doc, allow)
	assert.equal(actions.length, 2)
	for (const docstatus of [0, 2]) assert.equal(module.actions({ ...doc, docstatus }, allow).length, 0)
	assert.equal(module.actions({ ...doc, items: [{ pending_qty: 0 }] }, allow).length, 0)
	assert.equal(module.actions(doc, () => false).length, 0)
	const values = new Map()
	const storage = { setItem: (key, value) => values.set(key, value), getItem: (key) => values.get(key) }
	let route
	const mapped = mappedReceipt()
	const token = await openMappedDraft(actions[0], "PO-1", { storage, call: async (method, args) => {
		assert.equal(method, "frappe.model.mapper.make_mapped_doc")
		assert.deepEqual(args, { method: makeGoodsReceivedNote, source_name: "PO-1" })
		return mapped
	}, navigate: async (target) => { route = target } })
	assert.match(token, /^[\da-f-]{36}$/)
	assert.ok(values.has(`mgk:draft:${token}`))
	assert.deepEqual(route, { path: "/goods-received-note/new", query: { draft: token } })
	for (let refresh = 0; refresh < 2; refresh++) assert.deepEqual(readMappedDraft(token, mapped.doctype, storage), mapped)
	assert.deepEqual(documentModule(mapped.doctype).initialAutoFields({ ...readMappedDraft(token, mapped.doctype, storage), __islocal: 1 }),
		["supplier", "delivery_location", "warehouse"])
	assert.throws(() => readMappedDraft("lost", mapped.doctype, storage), /Draft expired/)
})

test("a PO row split Accepted/Rejected saves distinct entries with the same source, rate and UOM", () => {
	const groups = loadItems(itemDetails(), "grn_po")
	const accepted = groups[0].items[0]
	accepted.values.default.qty = 6
	const rejected = { name: "Yarn", attributes: {}, dimensions: { received_type: "Rejected" }, values: { default: { qty: 4 } } }
	preparePurchaseOrderEntry(rejected, [accepted])
	addEntry(groups, groups[0], rejected)
	assert.deepEqual(recalculate(groups, "grn_po"), { total_qty: 10, total_amount: 50 })
	const payload = editorSavePayload(mappedReceipt(), groups)
	assert.deepEqual(payload.items, [])
	const entries = JSON.parse(payload.item_details)[0].items
	assert.deepEqual(entries.map((entry) => entry.dimensions.received_type), ["Accepted", "Rejected"])
	assert.deepEqual(entries.map((entry) => entry.values.default.purchase_order_item), ["po-row", "po-row"])
	assert.deepEqual(entries.map((entry) => entry.values.default.rate), [5, 5])
	const amended = amendmentDraft({ ...mappedReceipt(), name: "GRN-1", docstatus: 2, items: [{ name: "old", purchase_order_item: "po-row" }] })
	assert.equal(amended.amended_from, "GRN-1")
	assert.equal(amended.items[0].name, undefined)
	assert.equal(amended.items[0].purchase_order_item, "po-row")
})

test("PO connected-record link supplies exactly its noncancelled GRN count filters to the list", () => {
	const link = documentModule("MGK Purchase Order").connections({ name: "PO / 1" })[0]
	assert.deepEqual(routeFilters(link.doctype, link.to.query), link.filters)
	assert.equal(routeFilters("MGK Purchase Order", link.to.query), null)
	assert.equal(routeFilters(link.doctype, {}), null)
})

test("summaries, overview facts, PO counts and invoice billing state come from the doctype module", async () => {
	const po = documentModule("MGK Purchase Order")
	assert.equal(po.summary({ total_amount: 50 }, 3).lines.find((line) => line.label === "Items").value, 3)
	assert.equal(po.viewFacts({ is_karigan_order: 1 }).find((fact) => fact.label === "Karigan order").value, "Yes")
	const grn = documentModule("MGK Goods Received Note")
	const doc = { ...mappedReceipt(), docstatus: 0, purchase_invoice: "PI-1", delivery_challans: [{ delivery_challan: "DC-1" }] }
	const calls = []
	const extra = await grn.loadPresentation(doc, { can: () => true, read: async (method, args) => {
		calls.push({ method, args }); return method.includes("get_counts") ? [2] : { docstatus: 1 }
	} })
	assert.equal(extra.fieldHints.purchase_order, "2 open Purchase Orders for Vendor")
	assert.deepEqual(calls.find((call) => call.method.includes("get_counts")).args.doctype_filter_sets[0].filters,
		[["docstatus", "=", 1], ["status", "in", ["To Receive", "Partially Received"]], ["supplier", "=", "Vendor"]])
	const facts = grn.viewFacts({ ...doc, ...extra })
	assert.equal(facts.find((fact) => fact.label === "Billing state").value, "Draft")
	assert.equal(grn.viewFacts({ ...doc, ...extra, docstatus: 1 }).find((fact) => fact.label === "Billing state").value, "Billed")
	assert.equal(facts.find((fact) => fact.label === "Delivery Challan").to, "/delivery-challan/DC-1")
	assert.equal(facts.find((fact) => fact.label === "Purchase Invoice").to, "/billing/PI-1")
	await grn.loadPresentation(doc, { can: () => false, read: () => assert.fail("Restricted reads must be skipped") })
})
