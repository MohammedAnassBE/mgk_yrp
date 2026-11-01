import { computed, ref } from "vue"
import { callRead } from "../api/client.js"

export const ENGLISH = "en"
export const TAMIL = "ta"
export const TAMIL_NAME_FIELD = "mgk_tamil_name"
export const TAMIL_NAME_DOCTYPES = Object.freeze(["Item", "Supplier", "Warehouse", "MGK Agent"])
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
	language.value = LANGUAGES.has(value) ? value : ENGLISH
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

/** Adds `tamil` to Link suggestions in Tamil mode; the stored value stays the record name. */
export async function withTamilNames(doctype, options) {
	if (!isTamilDisplay(doctype) || !options.length) return options
	const names = options.map((option) => option.value)
	const rows = await callRead("frappe.client.get_list", { doctype, fields: ["name", TAMIL_NAME_FIELD],
		filters: [["name", "in", names]], limit_page_length: names.length })
	const tamil = Object.fromEntries((rows || []).map((row) => [row.name, row[TAMIL_NAME_FIELD] || ""]))
	return options.map((option) => ({ ...option, tamil: tamil[option.value] || "" }))
}
