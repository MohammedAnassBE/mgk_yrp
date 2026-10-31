import test from "node:test"
import assert from "node:assert/strict"
import { ListLoader } from "../src/list/listLoader.js"
import { getMaster } from "../src/masters/mastersConfig.js"

test("Item loader keeps its base and OR filters in rows, counts and subsequent pages", async () => {
	const { baseFilters, baseOrFilters } = getMaster("items")
	const requests = []
	const loader = new ListLoader({ doctype: "Item", query: () => ({ baseFilters, baseOrFilters }), fields: () => ["name"],
		getRows: async (doctype, parameters) => { requests.push(parameters); return Array.from({ length: 20 }, (_, index) => ({ name: `Item ${parameters.limit_start + index}` })) },
		getCounts: async (sets) => { requests.push(sets); return [40, 40] },
	})
	await loader.load()
	await loader.more()
	for (const parameters of [requests[0], ...requests[1], requests[2]]) {
		assert.deepEqual(parameters.filters, baseFilters)
		assert.deepEqual(parameters.or_filters, baseOrFilters)
	}
	assert.equal(loader.state.rows.length, 40)
})

function deferred() {
	let resolve
	let reject
	const promise = new Promise((success, failure) => { resolve = success; reject = failure })
	return { promise, resolve, reject }
}

test("starts rows and a single total/all/tab count batch in parallel", async () => {
	const rows = deferred()
	const counts = deferred()
	const requests = []
	const loader = new ListLoader({
		doctype: "MGK Purchase Order", query: () => ({ tab: "karigan", tabs: [{ key: "karigan", filters: [["is_karigan_order", "=", 1]] }] }), fields: () => ["name"],
		getRows: (doctype, args) => { requests.push(args); return rows.promise },
		getCounts: (sets) => { requests.push(sets); return counts.promise },
	})
	const loading = loader.load(60)
	assert.equal(requests.length, 2)
	assert.equal(requests[0].limit, 60)
	assert.equal(requests[1].length, 3)
	rows.resolve([{ name: "PO-1" }]); counts.resolve([10, 10, 3])
	await loading
	assert.equal(loader.state.total, 3)
	assert.equal(loader.state.allTotal, 10)
	assert.deepEqual(loader.state.counts, { all: 10, karigan: 3 })
})

test("loadSequence drops stale rows and counts after a newer query finishes", async () => {
	const oldRows = deferred()
	const oldCounts = deferred()
	let first = true
	const loader = new ListLoader({ doctype: "PO", query: () => ({}), fields: () => ["name"], getRows: () => first ? oldRows.promise : [{ name: "new" }], getCounts: () => first ? oldCounts.promise : [1, 1] })
	const old = loader.load()
	first = false
	await loader.load()
	oldRows.resolve([{ name: "old" }]); oldCounts.resolve([99, 99])
	assert.equal(await old, false)
	assert.equal(loader.state.rows[0].name, "new")
	assert.equal(loader.state.total, 1)
	assert.equal(loader.state.loading, false)
})

test("more appends without recounting, deduplicates shifted rows, and uses loaded offset", async () => {
	let countCalls = 0
	const requests = []
	const loader = new ListLoader({ doctype: "PO", query: () => ({}), fields: () => ["name"], getRows: async (doctype, args) => { requests.push(args); return args.limit_start ? [{ name: "PO-20" }, { name: "PO-21" }] : Array.from({ length: 20 }, (_, index) => ({ name: `PO-${index + 1}` })) }, getCounts: async () => { countCalls += 1; return [40, 40] } })
	await loader.load()
	await loader.more()
	assert.equal(countCalls, 1)
	assert.equal(requests[1].limit_start, 20)
	assert.equal(loader.state.rows.length, 21)
	assert.equal(loader.state.total, 21)
})

test("old load-more completion does not overwrite a live refresh", async () => {
	const more = deferred()
	const loader = new ListLoader({ doctype: "PO", query: () => ({}), fields: () => ["name"], getRows: async (doctype, args) => args.limit_start ? more.promise : [{ name: "current" }], getCounts: async () => [40, 40] })
	await loader.load()
	const pending = loader.more()
	await loader.load(40)
	more.resolve([{ name: "stale" }])
	await pending
	assert.deepEqual(loader.state.rows, [{ name: "current" }])
	assert.equal(loader.state.loadingMore, false)
})

test("errors are retryable and disposal prevents pending results from applying", async () => {
	let fail = true
	const loader = new ListLoader({ doctype: "PO", query: () => ({}), fields: () => ["name"], getRows: async () => { if (fail) throw new Error("No access"); return [{ name: "PO-1" }] }, getCounts: async () => [1, 1] })
	await loader.load()
	assert.equal(loader.state.error, "No access")
	fail = false
	await loader.load()
	assert.equal(loader.state.error, "")
	const pending = loader.load()
	loader.dispose()
	assert.equal(await pending, false)
})
