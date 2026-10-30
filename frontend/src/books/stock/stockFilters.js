const keys = ["from_date", "to_date", "supplier", "warehouse", "item", "received_type"]

function localDate(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function defaultStockFilters(today = new Date()) {
	const from = new Date(today)
	from.setDate(from.getDate() - 30)
	return { from_date: localDate(from), to_date: localDate(today), supplier: "", warehouse: "", item: "", received_type: "" }
}

export function stockRequest(filters) {
	return { filters: Object.fromEntries(keys.map((key) => [key, filters[key] || ""])) }
}

export function supplierWarehouses(options, supplier) {
	return (options.warehouses || []).filter((row) => !supplier || row.supplier === supplier)
}
