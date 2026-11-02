import { computed, reactive, ref } from "vue"
import { callRead } from "../api/client.js"

export const ENGLISH = "en"
export const TAMIL = "ta"
export const TAMIL_NAME_FIELD = "mgk_tamil_name"
export const TAMIL_NAME_DOCTYPES = Object.freeze(["Item", "Supplier", "Warehouse", "MGK Agent", "YRP Process", "Item Group"])
const LANGUAGES = new Set([ENGLISH, TAMIL])

function storageKey() {
	const user = globalThis.window?.frappe?.boot?.user?.name || globalThis.window?.frappe?.session?.user || "Guest"
	return `mgk-display-language:${user}`
}

function storedLanguage() {
	try {
		const value = globalThis.window?.localStorage?.getItem(storageKey())
		return LANGUAGES.has(value) ? value : ENGLISH
	} catch {
		return ENGLISH
	}
}

/** Shared by the topbar toggle and every Link field so all labels switch together. */
export const language = ref(storedLanguage())
export const isTamil = computed(() => language.value === TAMIL)

export function setLanguage(value) {
	const next = LANGUAGES.has(value) ? value : ENGLISH
	if (next === TAMIL && language.value !== TAMIL) requested.clear()
	language.value = next
	try {
		globalThis.window?.localStorage?.setItem(storageKey(), language.value)
	} catch {
		// Blocked storage must not stop the in-session switch.
	}
}

export function hasTamilName(doctype) {
	return TAMIL_NAME_DOCTYPES.includes(doctype)
}

export function isTamilDisplay(doctype) {
	return isTamil.value && hasTamilName(doctype)
}

/** Link fields that point at a Tamil-named master, shared by list rows and report pages. */
export const LINK_FIELD_DOCTYPES = Object.freeze({
	supplier: "Supplier", delivery_location: "Supplier", from_location: "Supplier", to_location: "Supplier",
	handling_supplier: "Supplier", default_location: "Supplier",
	warehouse: "Warehouse", from_warehouse: "Warehouse", to_warehouse: "Warehouse", transit_warehouse: "Warehouse",
	mgk_agent: "MGK Agent", item: "Item", input_item: "Item", process_name: "YRP Process", item_group: "Item Group",
})
/** Each master's English title field, used where a master's own list shows its title. */
export const TITLE_FIELDS = Object.freeze({ Item: "item_name", Supplier: "supplier_name", Warehouse: "warehouse_name", "MGK Agent": "agent_name",
	"YRP Process": "process_name", "Item Group": "item_group_name" })
const LOOKUP_CHUNK = 100
const tamilNames = reactive({})
const englishTitles = reactive({})
const variantTemplates = reactive({})
const requested = new Set()
const queued = new Map()
const inFlight = new Set()
let flushScheduled = false

function cacheKey(doctype, name) { return `${doctype}\u0000${name}` }

/**
 * Tamil name of a Link value, or "" in English mode or when none is set. A cache miss queues one batched
 * `frappe.client.get_list` per doctype, so calling this from templates and computeds never fetches per row.
 * A variant without its own Tamil name shows its template's Tamil name plus the English variant suffix.
 */
export function tamilName(doctype, name) {
	return isTamilDisplay(doctype) ? storedTamilName(doctype, name) : ""
}

/** Tamil name of a Link value in either display language; Link suggestions show it as a second line. */
export function storedTamilName(doctype, name) {
	if (!name || !hasTamilName(doctype)) return ""
	const value = String(name)
	const key = cacheKey(doctype, value)
	if (!requested.has(key)) queueLookup(doctype, value, key)
	const template = variantTemplates[key]
	if (tamilNames[key] || !template || !value.startsWith(template)) return tamilNames[key] || ""
	const base = storedTamilName(doctype, template)
	return base ? `${base}${value.slice(template.length)}` : ""
}

/**
 * What to show for a Link value. Tamil mode: Tamil name, else English title, else the caller's label.
 * English mode: the caller's label, unchanged.
 */
export function displayName(doctype, name, english = name) {
	const tamil = tamilName(doctype, name)
	if (tamil || !isTamilDisplay(doctype) || !name) return tamil || english
	return englishTitles[cacheKey(doctype, String(name))] || english
}

export function fieldDisplayName(fieldname, value, english = value) {
	return LINK_FIELD_DOCTYPES[fieldname] ? displayName(LINK_FIELD_DOCTYPES[fieldname], value, english) : english
}

export function rememberTamilNames(doctype, rows) {
	for (const row of rows || []) {
		const key = cacheKey(doctype, row.name)
		requested.add(key)
		tamilNames[key] = row[TAMIL_NAME_FIELD] || ""
		if (row[TITLE_FIELDS[doctype]]) englishTitles[key] = String(row[TITLE_FIELDS[doctype]]).trim()
		if (!row.variant_of) continue
		variantTemplates[key] = row.variant_of
		if (!row[TAMIL_NAME_FIELD]) storedTamilName(doctype, row.variant_of)
	}
}

/** Drops a saved master's cached Tamil name so every display refetches it. */
export function forgetTamilName(doctype, name) {
	const key = cacheKey(doctype, name)
	requested.delete(key)
	delete tamilNames[key]
	delete englishTitles[key]
	delete variantTemplates[key]
}

/** Resolves once every queued and running lookup has finished. */
export async function tamilNamesSettled() {
	while (flushScheduled || inFlight.size) await Promise.all([Promise.resolve(), ...inFlight])
}

function queueLookup(doctype, name, key) {
	requested.add(key)
	if (!queued.has(doctype)) queued.set(doctype, new Set())
	queued.get(doctype).add(name)
	if (flushScheduled) return
	flushScheduled = true
	queueMicrotask(() => {
		flushScheduled = false
		const batches = [...queued]
		queued.clear()
		for (const [target, names] of batches) {
			const lookup = fetchTamilNames(target, [...names])
			inFlight.add(lookup)
			lookup.finally(() => inFlight.delete(lookup))
		}
	})
}

async function fetchTamilNames(doctype, names) {
	const fields = ["name", TAMIL_NAME_FIELD, TITLE_FIELDS[doctype], ...(doctype === "Item" ? ["variant_of"] : [])]
	for (let start = 0; start < names.length; start += LOOKUP_CHUNK) {
		const chunk = names.slice(start, start + LOOKUP_CHUNK)
		try {
			const rows = await callRead("frappe.client.get_list", { doctype, fields,
				filters: [["name", "in", chunk]], limit_page_length: chunk.length })
			rememberTamilNames(doctype, rows)
		} catch {
			// The English label stays; a later render retries the lookup.
			for (const name of chunk) requested.delete(cacheKey(doctype, name))
		}
	}
}

/** List tab label: Tamil mode prefers the tab's Item Group Tamil name, then the tab's own `tamil` text. */
export function tabLabel(tab) {
	if (!isTamil.value) return tab.label
	const group = (tab.filters || []).find(([fieldname, operator]) => fieldname === "item_group" && operator === "=")
	return (group && tamilName("Item Group", group[2])) || tab.tamil || tab.label
}

/** Adds `tamil` to Link suggestions in both languages; the stored value stays the record name. */
export async function withTamilNames(doctype, options) {
	if (!hasTamilName(doctype) || !options.length) return options
	for (const option of options) storedTamilName(doctype, option.value)
	await tamilNamesSettled()
	return options.map((option) => ({ ...option, tamil: storedTamilName(doctype, option.value) }))
}
