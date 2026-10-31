import { formatDate } from "../../shared/formatDate.js"
import { displayRows, fact, money, rows } from "../previewValues.js"

export function facts(doc) {
	return [fact("Against", doc.against), fact("Posting Date", formatDate(doc.posting_date)),
		fact("Bill No", doc.bill_no), fact("Bill Date", formatDate(doc.bill_date)), fact("Tax Type", doc.tax_type),
		fact("Net Total", money(doc.net_total)), fact("Grand Total", money(doc.grand_total)),
		fact("Comments", doc.comments, null, null, { optional: true })]
}

export const itemColumns = [
	{ key: "item", label: "Item" }, { key: "goods_received_note", label: "GRN", link: "/goods-received-note" },
	{ key: "qty", label: "Qty", numeric: true }, { key: "rate", label: "Rate", money: true },
	{ key: "amount", label: "Amount", money: true },
]

export function itemRows(preview) { return displayRows(rows(preview), itemColumns) }

export function progress() { return null }
