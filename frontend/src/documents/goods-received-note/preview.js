import { formatDate } from "../../shared/formatDate.js"
import { displayName } from "../../shell/displayLanguage.js"
import { fact, itemTableRows, money, rows } from "../previewValues.js"
import { statusPill } from "../../list/statusPill.js"
import { transferIntro } from "../shared/transit.js"

export function facts(doc) {
	const is_internal = Number(doc.is_internal_transfer)
	const deliveryChallans = [...new Set((doc.delivery_challans || []).map((row) => row.delivery_challan).filter(Boolean))]
	return [fact("Posting Date", formatDate(doc.posting_date)), fact("Delivery Location", displayName("Supplier", doc.delivery_location)),
		...(is_internal ? [fact("Against", "Internal transfer")] : []),
		...(doc.purchase_order ? [fact("PO", doc.purchase_order, "/purchase-order")] : []),
		...deliveryChallans.map((name, index, links) => fact(links.length > 1 ? `DC ${index + 1}` : "DC", name, "/delivery-challan")),
		fact("Process", displayName("YRP Process", doc.process_name)),
		...(is_internal ? [fact("Transfer status", doc.transfer_status)] : []),
		fact("Bill status", statusPill("MGK Goods Received Note", { ...doc, is_internal_transfer: 0 }).label, "/billing", doc.purchase_invoice || null),
		fact("Amount", money(doc.total_amount)),
		fact("Comments", doc.comments, null, null, { optional: true })]
}

export const itemColumns = [
	{ key: "item", label: "Item", doctype: "Item" }, { key: "received_type", label: "Received type" },
	{ key: "qty", label: "Qty", numeric: true }, { key: "rate", label: "Rate", money: true },
	{ key: "amount", label: "Amount", money: true }, { key: "transferred_qty", label: "Transferred Qty", numeric: true, internalOnly: true },
]

export function itemRows(preview) {
	const is_internal = Number(preview?.doc?.is_internal_transfer)
	return itemTableRows(rows(preview).map((row) => ({ ...row,
		transferred_qty: is_internal ? row.transferred_qty : "—",
	})), itemColumns)
}

export function progress() { return null }

export function intro(preview) {
	return transferIntro({ ...preview?.doc, items: rows(preview) })?.text || null
}
