import test from "node:test"
import assert from "node:assert/strict"
import { clickFilter, filterLabel, replaceEqualityFilter, statusFilter } from "../src/list/clickFilters.js"
import { lifecycleBulkActions } from "../src/list/bulkLifecycle.js"
import { button, mountSplit } from "./helpers/splitList.js"
import { mountComponent, nodes, settle, textContent } from "./helpers/component.js"

const DOCTYPE = "MGK Purchase Order"
const can = (granted) => (_doctype, permission) => granted.includes(permission)
const rows = [{ name: "D1", docstatus: 0 }, { name: "D2", docstatus: 0 }, { name: "S1", docstatus: 1 }, { name: "C1", docstatus: 2 }]

test("lifecycle bulk actions follow submit, cancel and delete permissions", () => {
	const keys = (meta, granted) => lifecycleBulkActions(DOCTYPE, meta, can(granted)).map((action) => action.key)
	assert.deepEqual(keys({ is_submittable: 1 }, ["submit", "cancel", "delete"]), ["bulk-submit", "bulk-cancel", "bulk-delete"])
	assert.deepEqual(keys({ is_submittable: 1 }, ["read", "write"]), [])
	assert.deepEqual(keys({ is_submittable: 1 }, ["cancel"]), ["bulk-cancel"])
	assert.deepEqual(keys({ is_submittable: 0 }, ["submit", "cancel", "delete"]), ["bulk-delete"])
	assert.deepEqual(keys(null, ["delete"]), ["bulk-delete"])
})

test("lifecycle bulk actions pick eligible rows by docstatus", () => {
	const [submit, cancel, remove] = lifecycleBulkActions(DOCTYPE, { is_submittable: 1 }, can(["submit", "cancel", "delete"]))
	assert.deepEqual(submit.eligible(rows).map((row) => row.name), ["D1", "D2"])
	assert.deepEqual(cancel.eligible(rows).map((row) => row.name), ["S1"])
	assert.deepEqual(remove.eligible(rows).map((row) => row.name), ["D1", "D2", "C1"])
	const [masterDelete] = lifecycleBulkActions("Supplier", { is_submittable: 0 }, can(["delete"]))
	assert.equal(masterDelete.eligible([{ name: "A", docstatus: 0 }]).length, 1)
	assert.match(submit.confirm(undefined, { rows }), /Submit 2 documents\?/)
	assert.match(remove.confirm(undefined, { rows }), /Delete 3 documents\?.*cannot be undone/)
	assert.equal(lifecycleBulkActions("MGK Delivery Challan Close", { is_submittable: 1 }, can(["cancel"]))[0].label, "Reopen")
})

test("bulk delete calls frappe.client.delete per eligible row and reports each failure", async () => {
	const [remove] = lifecycleBulkActions(DOCTYPE, { is_submittable: 1 }, can(["delete"]))
	const calls = []
	const call = async (method, args) => {
		calls.push([method, args.name])
		if (args.name === "D2") throw new Error("Linked with GRN-1")
	}
	const result = await remove.run({ rows }, { call })
	assert.deepEqual(calls, [["frappe.client.delete", "D1"], ["frappe.client.delete", "D2"], ["frappe.client.delete", "C1"]])
	assert.equal(result.message, "2 documents deleted.")
	assert.deepEqual(result.failures, ["D2: Linked with GRN-1"])
})

test("bulk cancel uses frappe.client.cancel only for submitted rows", async () => {
	const [cancel] = lifecycleBulkActions(DOCTYPE, { is_submittable: 1 }, can(["cancel"]))
	const calls = []
	const result = await cancel.run({ rows }, { call: async (method, args) => { calls.push([method, args]) } })
	assert.deepEqual(calls, [["frappe.client.cancel", { doctype: DOCTYPE, name: "S1" }]])
	assert.equal(result.message, "1 document cancelled.")
	assert.deepEqual(result.failures, [])
})

test("click filters cover Link, Select, Data, Check and Date values but not ID, numbers or blanks", () => {
	assert.deepEqual(clickFilter({ fieldname: "supplier", fieldtype: "Link" }, "Acme"), ["supplier", "=", "Acme"])
	assert.deepEqual(clickFilter({ fieldname: "po_date", fieldtype: "Date" }, "2026-10-30"), ["po_date", "=", "2026-10-30"])
	assert.deepEqual(clickFilter({ fieldname: "is_return", fieldtype: "Check" }, "1"), ["is_return", "=", 1])
	assert.equal(clickFilter({ fieldname: "name", fieldtype: "Data" }, "PO-1"), null)
	assert.equal(clickFilter({ fieldname: "total_qty", fieldtype: "Float" }, 4), null)
	assert.equal(clickFilter({ fieldname: "supplier", fieldtype: "Link" }, ""), null)
	assert.equal(clickFilter(undefined, "x"), null)
})

test("status pills filter on the field behind the shown status", () => {
	assert.deepEqual(statusFilter(DOCTYPE, { status: "To Receive", docstatus: 1 }), ["status", "=", "To Receive"])
	assert.deepEqual(statusFilter("MGK Delivery Challan", { docstatus: 0 }), ["docstatus", "=", 0])
	assert.deepEqual(statusFilter("MGK Delivery Challan", { docstatus: 1, close_status: "Closed" }), ["close_status", "=", "Closed"])
	assert.deepEqual(statusFilter("MGK Delivery Challan", { docstatus: 1, is_return: 1 }), ["is_return", "=", 1])
	assert.deepEqual(statusFilter("MGK Delivery Challan", { docstatus: 1, is_internal_transfer: 1, transfer_status: "In Transit" }), ["transfer_status", "=", "In Transit"])
	assert.deepEqual(statusFilter("Supplier", { disabled: 1 }), ["disabled", "=", 1])
	assert.deepEqual(statusFilter("MGK Supplier Credit Debit", { entry_type: "Debit" }), ["entry_type", "=", "Debit"])
	assert.deepEqual(statusFilter("MGK Purchase Invoice", { docstatus: 2 }), ["docstatus", "=", 2])
	assert.equal(statusFilter("MGK Goods Received Note", { docstatus: 1, purchase_invoice: "PI-1" }), null)
	assert.equal(statusFilter("Address", { docstatus: 0 }), null)
	assert.deepEqual(statusFilter("MGK Delivery Challan Close", { docstatus: 1, reopen_status: "Reopened" }), ["reopen_status", "=", "Reopened"])
})

test("replacing an equality filter keeps other filters and labels dates as DD-MM-YYYY", () => {
	const filters = [["supplier", "=", "A"], ["po_date", ">", "2026-01-01"]]
	assert.deepEqual(replaceEqualityFilter(filters, ["supplier", "=", "B"]), [["po_date", ">", "2026-01-01"], ["supplier", "=", "B"]])
	const fields = [{ fieldname: "po_date", label: "PO Date", fieldtype: "Date" }, { fieldname: "is_return", label: "Return", fieldtype: "Check" }]
	assert.equal(filterLabel(["po_date", "=", "2026-10-30"], fields), "PO Date = 30-10-2026")
	assert.equal(filterLabel(["po_date", "between", ["2026-10-01", "2026-10-30"]], fields), "PO Date between 01-10-2026 and 30-10-2026")
	assert.equal(filterLabel(["is_return", "=", 1], fields), "Return = Yes")
	assert.equal(filterLabel(["docstatus", "=", 2], []), "Document Status = Cancelled")
	assert.equal(filterLabel(["item_group", "in", ["A", "B"]], []), "item_group in A, B")
})

test("selection summary shows eligible counts, confirms, then toasts success and lists failures", async () => {
	const original = { fetch: globalThis.fetch, window: globalThis.window }
	const posted = []
	globalThis.window = { frappe: { boot: { user: {} } } }
	globalThis.fetch = async (url, options) => {
		const body = JSON.parse(options.body)
		posted.push([url, body.name])
		if (body.name === "C1") return { ok: false, status: 417, json: async () => ({ exc_type: "LinkExistsError", _server_messages: JSON.stringify([JSON.stringify({ message: "C1 is linked" })]) }) }
		return { ok: true, status: 200, json: async () => ({ message: "ok" }) }
	}
	let refreshed = 0
	const actions = lifecycleBulkActions(DOCTYPE, { is_submittable: 1 }, can(["submit", "cancel", "delete"]))
	const page = await mountComponent("../../src/list/SelectionSummary.vue", { rows: [rows[0], rows[3]], actions, refresh: async () => { refreshed++ } })
	try {
		assert.equal(button(page, "Submit (1)").props.disabled, false)
		assert.equal(button(page, "Cancel (0)").props.disabled, true)
		const running = button(page, "Delete (2)").props.onClick()
		await settle()
		assert.match(textContent(page.root), /Delete 2 documents\?/)
		button(page, "Confirm").props.onClick()
		await running; await settle()
		assert.deepEqual(posted.map(([, name]) => name), ["D1", "C1"])
		assert.equal(refreshed, 1)
		assert.match(textContent(page.root), /1 document deleted\./)
		assert.match(textContent(nodes(page.root, (node) => node.props.class === "server-error")[0]), /1 failed:\nC1: .*linked/)
	} finally { page.close(); globalThis.fetch = original.fetch; globalThis.window = original.window }
})

test("split rows filter by supplier, date and status without opening the preview", async () => {
	const filters = []
	const page = await mountSplit()
	try {
		page.props.filterFor = (row, fieldname) => fieldname === "__status" ? ["docstatus", "=", 1] : [fieldname, "=", row[fieldname]]
		page.props.onFilter = (filter) => filters.push(filter)
		await settle()
		const values = nodes(page.root, (node) => String(node.props.class || "").includes("list-filter-value"))
		const stopped = []
		for (const name of ["Supplier A", "30-10-2026", "Draft"]) {
			values.find((value) => textContent(value) === name).props.onClick({ stopPropagation: () => stopped.push(name) })
		}
		await settle()
		assert.deepEqual(filters, [["supplier", "=", "Supplier A"], ["po_date", "=", "2026-10-30"], ["docstatus", "=", 1]])
		assert.deepEqual(stopped, ["Supplier A", "30-10-2026", "Draft"])
		assert.equal(page.router.currentRoute.value.query.selected, "A")
	} finally { page.close() }
})
