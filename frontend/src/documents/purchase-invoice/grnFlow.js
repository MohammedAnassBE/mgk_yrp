import { clone } from "../../document/mappedDraft.js"
import { canGetGrns, previewFields } from "./fieldEvents.js"

const method = "mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice"
export const noGrnsMessage = "No unbilled GRNs for this supplier and type."

export function createGrnFlow({ getDoc, call, callDoc, update, messages }) {
	let sequence = 0
	let selection = null
	function isCurrent(source) {
		const doc = getDoc()
		return source && source.doc === doc && source.sequence === sequence && canGetGrns(doc)
			&& source.supplier === doc.supplier && source.against === doc.against
	}
	async function list() {
		const doc = getDoc()
		const current = ++sequence
		selection = null
		if (!canGetGrns(doc)) return []
		const source = { doc, sequence: current, supplier: doc.supplier, against: doc.against }
		try {
			const receipts = await call(`${method}.get_unbilled_grns`, { supplier: source.supplier, against: source.against })
			if (!isCurrent(source)) return []
			selection = { ...source, names: new Set(receipts.map((receipt) => receipt.name)) }
			if (!receipts.length) messages([noGrnsMessage])
			return receipts
		} catch (cause) { if (isCurrent(source)) throw cause; return [] }
	}
	async function fetch(names) {
		const source = selection
		if (!names.length || !isCurrent(source)) return false
		if (names.some((name) => !source.names.has(name))) throw new Error("Choose GRNs from the displayed list.")
		try {
			const rows = await call(`${method}.get_grn_rows`, { grn_names: [...new Set(names)] })
			if (!isCurrent(source)) return false
			update({ items: rows })
			const result = await callDoc(clone(getDoc()), "preview_taxes")
			if (!isCurrent(source)) return false
			if (!result.doc) throw new Error("The server returned no tax preview.")
			update(Object.fromEntries(previewFields.map((field) => [field, result.doc[field]])))
			messages(result.messages || [])
			selection = null
			return true
		} catch (cause) { if (isCurrent(source)) throw cause; return false }
	}
	return { list, fetch }
}
