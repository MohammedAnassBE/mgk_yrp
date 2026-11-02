import { shallowRef } from "vue"
import { callRead } from "../api/client.js"
import { isTamil } from "./displayLanguage.js"

export const TERMS_METHOD = "mgk_yrp.terminology.terms.get_ui_terms"
export const TERMS_EVENT = "mgk_ui_terms_updated"

const loaded = shallowRef(null)
const indexes = new WeakMap()

/** Lookup form of an English text, matching the server's `normalize`: case and spacing do not matter. */
export function normalizeTerm(english) {
	return String(english ?? "").split(/\s+/).filter(Boolean).join(" ").toLowerCase()
}

/** Term key to `{ source, ta }` from the editable YRP UI Terminology, delivered in boot and refreshed on edit. */
export function currentTerms() {
	return loaded.value || globalThis.window?.frappe?.boot?.terms || {}
}

function tamilIndex(terms) {
	if (!indexes.has(terms)) {
		indexes.set(terms, new Map(Object.values(terms).filter((row) => row?.source && row.ta && !row.keyed)
			.map((row) => [normalizeTerm(row.source), row.ta])))
	}
	return indexes.get(terms)
}

/** Tamil for an English UI text in Tamil mode, the English text otherwise or when no term exists. */
export function t(english) {
	if (!english || !isTamil.value) return english
	return tamilIndex(currentTerms()).get(normalizeTerm(english)) || english
}

/** Text of a term key: Tamil in Tamil mode, else the term's English, else `fallback`. */
export function term(key, fallback = "") {
	const row = key ? currentTerms()[key] : null
	if (!row) return fallback
	return (isTamil.value && row.ta) || row.source || fallback
}

/** Statuses whose English word means something else elsewhere, such as the Open button. */
const STATUS_TERMS = Object.freeze({ Open: "mgk.status_open" })

/** Text of a status label for tabs and pills. */
export function statusText(label) {
	return STATUS_TERMS[label] ? term(STATUS_TERMS[label], t(label)) : t(label)
}

export function setTerms(terms) {
	loaded.value = terms && typeof terms === "object" ? { ...terms } : null
}

/** Reloads the terms after a Desk edit so open pages switch without a reload. */
export async function refreshTerms() {
	setTerms(await callRead(TERMS_METHOD))
}
