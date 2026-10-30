import test from "node:test"
import assert from "node:assert/strict"
import { columnDraft, visibleColumns, getUserColumns, saveUserColumns, resetUserColumns } from "../src/list/listColumns.js"
import { clearReadCaches } from "../src/api/client.js"

const meta = { fields: [{ fieldname: "supplier", label: "Supplier", fieldtype: "Link" }, { fieldname: "po_date", label: "PO Date", fieldtype: "Date" }, { fieldname: "status", label: "Status", fieldtype: "Select" }, { fieldname: "items", fieldtype: "Table" }, { fieldname: "secret", fieldtype: "Data", hidden: 1 }] }
const defaults = ["name", "supplier", "po_date", "status"]

test("default columns fix ID first and Status last while excluding hidden/table/system fields", () => {
	const columns = columnDraft(meta, defaults, null, "status")
	assert.deepEqual(columns.map((column) => column.fieldname), ["supplier", "po_date"])
	assert.deepEqual(visibleColumns(columns).map((column) => column.fieldname), ["name", "supplier", "po_date", "__status"])
	assert.deepEqual(visibleColumns(columnDraft(meta, defaults, [], "status")).map((column) => column.fieldname), ["name", "__status"])
})

test("base yrp raw-array response preserves enabled order and drops obsolete fields", () => {
	const saved = [{ fieldname: "name", enabled: 1 }, { fieldname: "po_date", enabled: 1 }, { fieldname: "obsolete", enabled: 1 }, { fieldname: "supplier", enabled: 0 }, { fieldname: "status", enabled: 1 }]
	const columns = columnDraft(meta, defaults, saved, "status")
	assert.deepEqual(columns.map((column) => [column.fieldname, column.enabled]), [["po_date", true], ["supplier", false]])
	assert.deepEqual(visibleColumns(columns).map((column) => column.fieldname), ["name", "po_date", "__status"])
})

test("save -> reload keeps order -> Reset uses exact base yrp methods, arguments and return shapes", async () => {
	const originalFetch = globalThis.fetch
	const calls = []
	let saved = null
	globalThis.fetch = async (url, options) => {
		calls.push([url, options])
		const args = options.body ? JSON.parse(options.body) : Object.fromEntries(new URL(url, "http://site").searchParams)
		assert.equal(args.doctype_name, "MGK Purchase Order")
		let message = "ok"
		if (url.includes("save_user_listview")) saved = args.columns
		else if (url.includes("reset_user_listview")) saved = null
		else message = saved
		return { status: 200, ok: true, json: async () => ({ message }) }
	}
	try {
		const columns = columnDraft(meta, defaults, [{ fieldname: "po_date", enabled: 1 }, { fieldname: "supplier", enabled: 1 }], "status")
		assert.equal(await saveUserColumns("MGK Purchase Order", columns), "ok")
		const reloaded = columnDraft(meta, defaults, await getUserColumns("MGK Purchase Order"), "status")
		assert.deepEqual(visibleColumns(reloaded).map((column) => column.fieldname), ["name", "po_date", "supplier", "__status"])
		assert.equal(await resetUserColumns("MGK Purchase Order"), "ok")
		assert.equal(await getUserColumns("MGK Purchase Order"), null)
		assert.match(calls[0][0], /yrp\.yrp\.doctype\.yrp_user_listview\.yrp_user_listview\.save_user_listview$/)
	} finally { globalThis.fetch = originalFetch; clearReadCaches() }
})
