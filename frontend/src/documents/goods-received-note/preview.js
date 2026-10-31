import { displayRows, fact, money, rows } from "../previewValues.js"
import { statusPill } from "../../list/statusPill.js"
import { transferIntro } from "../shared/transit.js"

export function facts(doc) {
	const is_internal = Number(doc.is_internal_transfer)
	return [fact("Supplier", doc.supplier), fact("Posting Date", doc.posting_date),
		fact("Against", is_internal ? "Internal transfer" : Number(doc.against_purchase_order) ? "Purchase Order" : "Job Work"),
		...(doc.purchase_order ? [fact("Purchase Order", doc.purchase_order, "/purchase-order")] : []),
		...(doc.delivery_challans || []).map((row, index, links) => fact(links.length > 1 ? `DC ${index + 1}` : "DC", row.delivery_challan, "/delivery-challan")),
		fact("Process", doc.process_name), fact("Warehouse", doc.warehouse),
		...(is_internal ? [fact("Transfer status", doc.transfer_status)] : []),
		fact("Bill status", statusPill("MGK Goods Received Note", { ...doc, is_internal_transfer: 0 }).label, "/billing", doc.purchase_invoice || null),
		fact("Amount", money(doc.total_amount))]
}

export const itemColumns = [
	{ key: "item", label: "Item" }, { key: "received_type", label: "Received type" },
	{ key: "qty", label: "Qty", numeric: true }, { key: "rate", label: "Rate", money: true },
	{ key: "amount", label: "Amount", money: true }, { key: "transferred_qty", label: "Transferred Qty", numeric: true },
]

export function itemRows(preview) {
	const is_internal = Number(preview?.doc?.is_internal_transfer)
	return displayRows(rows(preview).map((row) => ({ ...row,
		transferred_qty: is_internal ? row.transferred_qty : "—",
	})), itemColumns)
}

export function progress() { return null }

export function intro(preview) {
	return transferIntro({ ...preview?.doc, items: rows(preview) })?.text || null
}
