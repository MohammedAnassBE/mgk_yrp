import test from "node:test"
import assert from "node:assert/strict"
import { listStateKey, normalizeListState, readListState, saveListState, stageNewDefaults, readNewDefaults } from "../src/list/listState.js"

function storage() {
	const values = new Map()
	return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }
}

test("saves and restores filters, zero quick values, sort, tab, loaded count and whole-page scroll", () => {
	const store = storage()
	const key = listStateKey("MGK Purchase Order", "/purchase-order", "one@example.test")
	const state = { filters: [["supplier", "=", "S-1"]], quickFilters: { against_purchase_order: 0 }, search: "PO", tab: "karigan", selected: "PO-42", sortField: "creation", sortDirection: "asc", loadedCount: 80, scrollTop: 1450 }
	assert.equal(readListState(key, store), null)
	saveListState(key, state, store)
	assert.deepEqual(readListState(key, store), state)
	assert.notEqual(key, listStateKey("MGK Purchase Order", "/purchase-order", "two@example.test"))
	const copy = readListState(key, store)
	copy.filters[0][2] = "changed"
	assert.equal(readListState(key, store).filters[0][2], "S-1")
})

test("normalizes bad paging values and surfaces corrupt/unavailable session storage", () => {
	assert.equal(normalizeListState({ loadedCount: -1, scrollTop: -20 }).loadedCount, 20)
	assert.equal(normalizeListState({ scrollTop: -20 }).scrollTop, 0)
	assert.equal(normalizeListState({}).selected, "")
	assert.throws(() => readListState("key", { getItem: () => "bad JSON" }), SyntaxError)
	assert.throws(() => saveListState("key", {}, { setItem: () => { throw new Error("Storage blocked") } }), /Storage blocked/)
})

test("new defaults survive a route reload and are bound to the requested doctype", () => {
	const store = storage()
	const token = stageNewDefaults("MGK Goods Received Note", { against_purchase_order: 0 }, "/goods-received-note?tab=job-work", store)
	assert.deepEqual(readNewDefaults(token, "MGK Goods Received Note", store), { doctype: "MGK Goods Received Note", defaults: { against_purchase_order: 0 }, source: "/goods-received-note?tab=job-work" })
	assert.throws(() => readNewDefaults(token, "MGK Purchase Order", store), /another book/)
	assert.equal(readNewDefaults("missing", "MGK Goods Received Note", store), null)
})
