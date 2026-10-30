export const PAGE_SIZE = 20

export function orderedTabs(tabs = []) {
	return [{ key: "all", label: "All", filters: [] }, ...tabs.filter((tab) => tab.key !== "all")]
}

export function deterministicOrder(field = "modified", direction = "desc") {
	if (!/^[a-zA-Z_][\w]*$/.test(field)) throw new Error("Invalid sort field.")
	const order = direction === "asc" ? "asc" : "desc"
	return field === "name" ? `name ${order}` : `${field} ${order}, name ${order}`
}

export function dateRangeFilters(field, value) {
	const [from, to] = Array.isArray(value) ? value : [value, value]
	if (from && to) return [[field, "between", [from, to]]]
	if (from) return [[field, ">=", from]]
	if (to) return [[field, "<=", to]]
	return []
}

export function quickFilterTuples(fields, values = {}) {
	return fields.flatMap((field) => {
		const value = values[field.fieldname]
		if (value === "" || value === undefined || value === null) return []
		return [[field.fieldname, "=", field.fieldtype === "Check" ? Number(value) : value]]
	})
}

export function restoreQuickDateRanges(fields, query) {
	const quickFilters = { ...query.quickFilters }
	const filters = [...query.filters]
	for (const field of fields) {
		const value = quickFilters[field.fieldname]
		if (field.fieldtype !== "Date" || !Array.isArray(value)) continue
		filters.push(...dateRangeFilters(field.fieldname, value))
		delete quickFilters[field.fieldname]
	}
	return { quickFilters, filters }
}

export function sharedFilters(query) {
	const filters = [...(query.baseFilters || []), ...(query.filters || []), ...quickFilterTuples(query.quickFields || [], query.quickFilters)]
	if (query.search?.trim()) filters.push(["name", "like", `%${query.search.trim()}%`])
	return filters
}

export function activeFilters(query) {
	const tab = orderedTabs(query.tabs).find((candidate) => candidate.key === query.tab)
	return [...sharedFilters(query), ...(tab?.filters || [])]
}

export function countRequests(doctype, query) {
	const common = sharedFilters(query)
	return [
		{ doctype, filters: common },
		...orderedTabs(query.tabs).map((tab) => ({ doctype, filters: [...common, ...tab.filters] })),
	]
}

export function rowParameters(query, fields, start = 0, limit = PAGE_SIZE) {
	return {
		fields: [...new Set(fields)], filters: activeFilters(query),
		order_by: deterministicOrder(query.sortField, query.sortDirection), limit_start: start, limit,
	}
}

export function resourceRequest(doctype, parameters, maxLength = 1800) {
	const query = new URLSearchParams()
	for (const [key, value] of Object.entries(parameters)) {
		query.set(key, typeof value === "object" ? JSON.stringify(value) : String(value))
	}
	const url = `/api/resource/${encodeURIComponent(doctype)}?${query}`
	if (url.length <= maxLength) return { url, options: {} }
	const { limit, ...args } = parameters
	return {
		url: "/api/method/frappe.client.get_list",
		options: { method: "POST", body: JSON.stringify({ doctype, ...args, limit_page_length: limit }) },
	}
}

export function equalityDefaults(filters, fields) {
	const allowed = new Set(fields.filter((field) => !field.read_only && !field.hidden).map((field) => field.fieldname))
	return Object.fromEntries(filters.filter(([field, operator]) => operator === "=" && allowed.has(field)).map(([field, , value]) => [field, value]))
}

export function trailingTask(callback, delay) {
	let timer
	const run = (...args) => {
		clearTimeout(timer)
		timer = setTimeout(() => callback(...args), delay)
	}
	run.cancel = () => clearTimeout(timer)
	return run
}
