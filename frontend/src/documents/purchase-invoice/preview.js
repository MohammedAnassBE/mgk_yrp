import { displayRows, fact, money, rows } from "../previewValues.js"

export function facts(doc) {
	return [fact("Supplier", doc.supplier), fact("Against", doc.against), fact("Posting Date", doc.posting_date),
		fact("Bill No", doc.bill_no), fact("Bill Date", doc.bill_date), fact("Tax Type", doc.tax_type),
		fact("Net Total", money(doc.net_total)), fact("Grand Total", money(doc.grand_total))]
}

export const itemColumns = [
	{ key: "item", label: "Item" }, { key: "goods_received_note", label: "GRN" },
	{ key: "qty", label: "Qty", numeric: true }, { key: "rate", label: "Rate", money: true },
	{ key: "amount", label: "Amount", money: true },
]

export function itemRows(preview) { return displayRows(rows(preview), itemColumns) }

export function progress() { return null }
