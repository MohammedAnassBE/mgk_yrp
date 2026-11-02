import { displayName } from "../shell/displayLanguage.js"

export function fact(label, value, route, name = value, { optional = false } = {}) {
	return { label, value: value == null || value === "" ? "—" : value,
		optional, ...(route && name ? { to: `${route}/${encodeURIComponent(name)}`, name } : {}) }
}

export function visibleFacts(facts) {
	return facts.filter((fact) => !fact.optional || fact.value !== "—")
}

export function remainingConnections(connections = [], facts = [], columns = [], items = []) {
	const linked = new Set(facts.filter((fact) => fact.to).map((fact) => fact.name))
	for (const column of columns.filter((column) => column.link)) {
		for (const item of items) linked.add(item[column.key])
	}
	return connections.map((group) => ({ ...group, names: group.names.filter((name) => !linked.has(name)) }))
		.filter((group) => group.names.length)
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

const attributeKey = (attribute) => `attribute:${attribute}`

/** Inserts one column per variant attribute present in `items` right after the item column. */
export function withAttributeColumns(columns, items = []) {
	const attributes = [...new Set(items.flatMap((row) => Object.keys(row.item_attributes || {})))]
	if (!attributes.length) return columns
	const index = columns.findIndex((column) => column.key === "item") + 1
	const added = attributes.map((attribute) => ({ key: attributeKey(attribute), label: attribute }))
	return [...columns.slice(0, index), ...added, ...columns.slice(index)]
}

/** Display rows keyed by the template item plus its attribute values, so Tamil mode can name the template. */
export function itemTableRows(items, columns) {
	return displayRows(items.map((row) => ({ ...row, item: row.item_template || row.item,
		...Object.fromEntries(Object.entries(row.item_attributes || {}).map(([attribute, value]) => [attributeKey(attribute), value])),
	})), withAttributeColumns(columns, items))
}

export function displayRows(items, columns) {
	return items.map((row) => Object.fromEntries(columns.map((column) => [column.key, cellValue(row[column.key], column)])))
}

function cellValue(value, column) {
	if (value != null && value !== "" && value !== "—") return column.doctype ? displayName(column.doctype, value) : value
	return column.numeric || column.money ? null : "—"
}

const amountFactLabels = new Set(["amount", "grand total", "total dc value"])

export function isAmountFact(fact) { return amountFactLabels.has(String(fact.label).toLowerCase()) }

export function isTotalColumn(column) {
	return Boolean((column.numeric && /qty/i.test(column.key)) || (column.money && /amount/i.test(column.key)))
}

export function columnTotals(columns, items) {
	if (items.length < 2) return null
	const totals = columns.filter(isTotalColumn).map((column) => {
		const values = items.map((item) => item[column.key]).filter((value) => value != null && value !== "" && value !== "—")
		return [column.key, values.length ? values.reduce((sum, value) => sum + Number(value), 0) : null]
	})
	return totals.length ? Object.fromEntries(totals) : null
}
