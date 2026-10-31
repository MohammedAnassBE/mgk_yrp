import { formatDate } from "../../shared/formatDate.js"
import { fact, money } from "../previewValues.js"

export function facts(doc) {
	return [fact("Supplier", doc.supplier), fact("Date", formatDate(doc.posting_date)), fact("Type", doc.entry_type),
		fact("Amount", money(doc.amount)), fact("Reason", doc.reason)]
}

export const itemColumns = []

export function itemRows() { return [] }

export function progress() { return null }
