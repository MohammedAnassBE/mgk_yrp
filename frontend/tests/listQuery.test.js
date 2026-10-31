import test from "node:test"
import assert from "node:assert/strict"
import { activeFilters, countRequests, deterministicOrder, equalityDefaults, orderedTabs, quickFilterTuples, resourceRequest, restoreQuickDateRanges, rowParameters, trailingTask } from "../src/list/listQuery.js"
import { fieldConditions, filterTuples } from "../src/list/filterFields.js"
import purchaseOrder from "../src/books/purchase-order/config.js"
import grn from "../src/books/goods-received-note/config.js"
import billing from "../src/books/billing/config.js"
import { getMaster } from "../src/masters/mastersConfig.js"
import { statusPill } from "../src/list/statusPill.js"
import { getRows } from "../src/list/listApi.js"
import { clearReadCaches } from "../src/api/client.js"

test("Item OR filters reach resource GET, get_list POST and every count set", () => {
	const { baseFilters, baseOrFilters } = getMaster("items")
	const query = { baseFilters, baseOrFilters, filters: [["item_group", "=", "Yarn"]], search: "Template", tabs: [{ key: "disabled", filters: [["disabled", "=", 1]] }], tab: "disabled" }
	const before = structuredClone(query)
	const parameters = rowParameters(query, ["name"])
	assert.deepEqual(parameters.or_filters, baseOrFilters)
	assert.deepEqual(parameters.filters, [...baseFilters, ["item_group", "=", "Yarn"], ["name", "like", "%Template%"], ["disabled", "=", 1]])
	const get = resourceRequest("Item", parameters)
	assert.deepEqual(JSON.parse(new URL(get.url, "http://site").searchParams.get("or_filters")), baseOrFilters)
	const post = resourceRequest("Item", parameters, 10)
	assert.deepEqual(JSON.parse(post.options.body).or_filters, baseOrFilters)
	for (const set of countRequests("Item", query)) assert.deepEqual(set.or_filters, baseOrFilters)
	assert.deepEqual(query, before)
	assert.deepEqual(statusPill("Item", { has_variants: 1, disabled: 1 }), { label: "Disabled", className: "status-disabled" })
})

test("list API accepts orFilters and sends Frappe or_filters on GET and POST", async () => {
	const original = globalThis.fetch
	const requests = []
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options })
		return { ok: true, status: 200, json: async () => ({ data: [{ name: "Template" }] }) }
	}
	try {
		const orFilters = [["has_variants", "=", 1], ["disabled", "=", 0]]
		for (const search of ["short", "x".repeat(2000)]) {
			assert.deepEqual(await getRows("Item", { fields: ["name"], filters: [["name", "like", search]], orFilters, limit: 20 }), [{ name: "Template" }])
		}
		assert.deepEqual(JSON.parse(new URL(requests[0].url, "http://site").searchParams.get("or_filters")), orFilters)
		assert.equal(requests[1].url, "/api/method/frappe.client.get_list")
		assert.deepEqual(JSON.parse(requests[1].options.body).or_filters, orFilters)
		assert.equal(JSON.parse(requests[1].options.body).orFilters, undefined)
	} finally { globalThis.fetch = original; clearReadCaches() }
})

test("combines base, advanced, quick, search and tab filters without mutation", () => {
	const query = {
		baseFilters: [["docstatus", "!=", 2]], filters: [["total_qty", ">", 2]],
		quickFields: [{ fieldname: "po_date", fieldtype: "Date" }], quickFilters: { po_date: "2026-10-29" },
		search: " PO-1 ", tabs: purchaseOrder.tabs, tab: "karigan", sortField: "po_date", sortDirection: "asc",
	}
	const before = structuredClone(query)
	const request = rowParameters(query, ["name", "supplier", "name"], 20, 40)
	assert.deepEqual(request, {
		fields: ["name", "supplier"], filters: [["docstatus", "!=", 2], ["total_qty", ">", 2], ["po_date", "=", "2026-10-29"], ["name", "like", "%PO-1%"], ["item_group", "=", "Karigan Items"]],
		order_by: "po_date asc, name asc", limit_start: 20, limit: 40,
	})
	assert.deepEqual(query, before)
	const counts = countRequests(purchaseOrder.doctype, query)
	assert.equal(counts.length, 4)
	assert.deepEqual(counts[0].filters, request.filters.slice(0, -1))
	assert.deepEqual(counts[1], counts[0])
	assert.deepEqual(counts[3].filters.at(-1), ["item_group", "=", "Salavai Cone Items"])
})

test("All is always first, unknown tab falls back to All, DC has one countable tab", () => {
	assert.deepEqual(orderedTabs([{ key: "x", filters: [] }, { key: "all", filters: [["bad", "=", 1]] }]).map((tab) => tab.key), ["all", "x"])
	assert.deepEqual(activeFilters({ tabs: purchaseOrder.tabs, tab: "missing" }), [])
	assert.equal(orderedTabs([]).length, 1)
})

test("sort has a matching-direction ID tie-break and rejects invalid field expressions", () => {
	assert.equal(deterministicOrder(), "modified desc, name desc")
	assert.equal(deterministicOrder("creation", "asc"), "creation asc, name asc")
	assert.equal(deterministicOrder("name", "asc"), "name asc")
	assert.throws(() => deterministicOrder("name; select"), /Invalid/)
})

test("quick dates use equals and quick filters preserve zero and omit empty values", () => {
	const fields = [{ fieldname: "against_purchase_order", fieldtype: "Check" }, { fieldname: "posting_date", fieldtype: "Date" }]
	assert.deepEqual(quickFilterTuples(fields, { against_purchase_order: 0, posting_date: "2026-01-01" }), [["against_purchase_order", "=", 0], ["posting_date", "=", "2026-01-01"]])
	assert.deepEqual(quickFilterTuples(fields, { against_purchase_order: "0", posting_date: "" }), [["against_purchase_order", "=", 0]])
	for (const posting_date of ["", null, undefined]) assert.deepEqual(quickFilterTuples(fields, { posting_date }), [])
})

test("saved quick date ranges move to advanced filters without changing their meaning", () => {
	const fields = [{ fieldname: "posting_date", fieldtype: "Date" }, { fieldname: "supplier", fieldtype: "Link" }]
	for (const [value, expected] of [
		[["2026-01-01", "2026-01-31"], [["posting_date", "between", ["2026-01-01", "2026-01-31"]]]],
		[["2026-01-01", ""], [["posting_date", ">=", "2026-01-01"]]],
		[["", "2026-01-31"], [["posting_date", "<=", "2026-01-31"]]],
		[["", ""], []],
	]) {
		const query = { filters: [["docstatus", "=", 1]], quickFilters: { posting_date: value, supplier: "S-1" } }
		const before = structuredClone(query)
		assert.deepEqual(restoreQuickDateRanges(fields, query), { filters: [...query.filters, ...expected], quickFilters: { supplier: "S-1" } })
		assert.deepEqual(query, before)
	}
})

test("resource GET uses encoded DocType and long URLs switch to Frappe POST pagination arguments", () => {
	const parameters = rowParameters({}, ["name"], 40, 20)
	const get = resourceRequest("MGK Purchase Order", parameters)
	assert.match(get.url, /^\/api\/resource\/MGK%20Purchase%20Order\?/)
	assert.equal(new URL(get.url, "http://site").searchParams.get("limit"), "20")
	const post = resourceRequest("MGK Purchase Order", parameters, 10)
	assert.equal(post.options.method, "POST")
	assert.deepEqual(JSON.parse(post.options.body), { doctype: "MGK Purchase Order", fields: ["name"], filters: [], order_by: "modified desc, name desc", limit_start: 40, limit_page_length: 20 })
})

test("Desk conditions exclude invalid operators per field type", () => {
	const allowed = (fieldtype) => fieldConditions({ fieldtype }).map(([value]) => value)
	assert.deepEqual(allowed("Check"), ["="])
	assert.ok(allowed("Date").includes("between"))
	assert.ok(allowed("Date").includes("timespan"))
	assert.ok(!allowed("Date").includes("like"))
	assert.ok(!allowed("Link").includes(">"))
	assert.ok(!allowed("Datetime").includes("="))
	assert.ok(!allowed("Select").includes("like"))
})

test("advanced filters emit Between, Timespan, In and Is Frappe tuples", () => {
	const fields = [{ fieldname: "date", fieldtype: "Date", label: "Date" }, { fieldname: "supplier", fieldtype: "Link", label: "Supplier" }]
	assert.deepEqual(filterTuples([
		{ field: "date", operator: "between", value: "2026-01-01", end: "2026-02-01" },
		{ field: "date", operator: "timespan", value: "last 7 days" },
		{ field: "supplier", operator: "in", value: "S-1, S-2" },
		{ field: "supplier", operator: "is", value: "not set" },
	], fields), [["date", "between", ["2026-01-01", "2026-02-01"]], ["date", "timespan", "last 7 days"], ["supplier", "in", ["S-1", "S-2"]], ["supplier", "is", "not set"]])
	assert.throws(() => filterTuples([{ field: "supplier", operator: "=", value: "" }], fields), /Enter a value/)
	assert.throws(() => filterTuples([{ field: "supplier", operator: ">", value: "x" }], fields), /valid field/)
	assert.throws(() => filterTuples([{ field: "date", operator: "between", value: "2026-02-01", end: "2026-01-01" }], fields), /range end/)
})

test("New stages each book tab's equality defaults and excludes read-only/system/search filters", () => {
	for (const [book, tab, expected] of [
		[purchaseOrder, "karigan", { item_group: "Karigan Items" }], [grn, "purchase-order", { against_purchase_order: 1 }], [grn, "job-work", { against_purchase_order: 0 }], [billing, "job-work", { against: "Job Work" }],
	]) {
		const fields = Object.keys(expected).map((fieldname) => ({ fieldname }))
		const filters = activeFilters({ tabs: book.tabs, tab, search: "PO-1", filters: [["status", "=", "Completed"]] })
		assert.deepEqual(equalityDefaults(filters, [...fields, { fieldname: "status", read_only: 1 }]), expected)
	}
})

test("trailing tasks coalesce and cancellation prevents pending work", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] })
	const events = []
	const run = trailingTask((value) => events.push(value), 500)
	run(1); t.mock.timers.tick(400); run(2); t.mock.timers.tick(499)
	assert.deepEqual(events, [])
	t.mock.timers.tick(1)
	assert.deepEqual(events, [2])
	run(3); run.cancel(); t.mock.timers.tick(500)
	assert.deepEqual(events, [2])
})
