export function fact(label, value, route, name = value) {
	return { label, value: value == null || value === "" ? "—" : value,
		...(route && name ? { to: `${route}/${encodeURIComponent(name)}` } : {}) }
}

export function money(value) {
	return value == null || value === "" ? "—" : Number(value).toLocaleString("en-IN", {
		minimumFractionDigits: 2, maximumFractionDigits: 2,
	})
}

export function rows(preview) { return preview?.items ?? preview?.doc?.items ?? [] }

export function total(items, field) {
	return items.every((row) => row[field] != null && row[field] !== "")
		? items.reduce((sum, row) => sum + Number(row[field]), 0) : "—"
}

export function displayRows(items, columns) {
	return items.map((row) => Object.fromEntries(columns.map((column) => [column.key, cellValue(row[column.key], column)])))
}

function cellValue(value, column) {
	if (value != null && value !== "" && value !== "—") return value
	return column.numeric || column.money ? null : "—"
}
