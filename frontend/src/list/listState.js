const PREFIX = "mgk:list:v1"

export function listStateKey(doctype, route, user = globalThis.window?.frappe?.boot?.user?.name || "") {
	return [PREFIX, user, doctype, route].map(encodeURIComponent).join(":")
}

export function normalizeListState(state = {}) {
	return {
		filters: Array.isArray(state.filters) ? JSON.parse(JSON.stringify(state.filters)) : [],
		quickFilters: JSON.parse(JSON.stringify(state.quickFilters || {})),
		search: String(state.search || ""), tab: String(state.tab || "all"),
		selected: String(state.selected || ""),
		sortField: String(state.sortField || "modified"),
		sortDirection: state.sortDirection === "asc" ? "asc" : "desc",
		loadedCount: Math.max(20, Math.floor(Number(state.loadedCount) || 20)),
		scrollTop: Math.max(0, Number(state.scrollTop) || 0),
	}
}

export function saveListState(key, state, storage = window.sessionStorage) {
	storage.setItem(key, JSON.stringify(normalizeListState(state)))
}

export function readListState(key, storage = window.sessionStorage) {
	const raw = storage.getItem(key)
	return raw ? normalizeListState(JSON.parse(raw)) : null
}

export function stageNewDefaults(doctype, defaults, source, storage = window.sessionStorage) {
	const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	storage.setItem(`mgk:new:${token}`, JSON.stringify({ doctype, defaults, source }))
	return token
}

export function readNewDefaults(token, doctype, storage = window.sessionStorage) {
	const raw = storage.getItem(`mgk:new:${token}`)
	const state = raw ? JSON.parse(raw) : null
	if (state && state.doctype !== doctype) throw new Error("The defaults belong to another book.")
	return state
}
