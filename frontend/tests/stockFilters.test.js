import test from "node:test"
import assert from "node:assert/strict"
import { defaultStockFilters, stockRequest, supplierWarehouses } from "../src/books/stock/stockFilters.js"

test("stock defaults use local dates and the last 30 days across month boundaries", () => {
	assert.deepEqual(defaultStockFilters(new Date(2026, 0, 10, 0, 5)), {
		from_date: "2025-12-11", to_date: "2026-01-10", supplier: "", warehouse: "", item: "", received_type: "",
	})
})

test("Stock filter request nests only supported picker values under filters", () => {
	const filters = { from_date: "2026-10-01", to_date: "2026-10-29", supplier: "Supplier / 1", warehouse: "W", item: "Yarn", received_type: "Accepted", injected: 1 }
	assert.deepEqual(stockRequest(filters), { filters: { from_date: "2026-10-01", to_date: "2026-10-29", supplier: "Supplier / 1", warehouse: "W", item: "Yarn", received_type: "Accepted" } })
	assert.equal(stockRequest({}).filters.item, "")
	const options = { warehouses: [{ name: "A", supplier: "S" }, { name: "B", supplier: "T" }] }
	assert.deepEqual(supplierWarehouses(options, "S"), [options.warehouses[0]])
	assert.equal(supplierWarehouses(options, "").length, 2)
	assert.deepEqual(supplierWarehouses(options, "Unknown"), [])
})
