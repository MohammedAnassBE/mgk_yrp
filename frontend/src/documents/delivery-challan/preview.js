import { formatDate } from "../../shared/formatDate.js"
import { displayName } from "../../shell/displayLanguage.js"
import { fact, itemTableRows, money, rows } from "../previewValues.js"
import { pendingTransferQuantity } from "../shared/transit.js"

export function facts(doc) {
	return [fact("Process", Number(doc.is_internal_transfer) ? "Internal transfer" : displayName("YRP Process", doc.process_name)),
		fact("Posting Date", formatDate(doc.posting_date)), fact("Vehicle", doc.vehicle_number, null, null, { optional: true }),
		fact("Declared Value", money(doc.total_declared_value)),
		fact("Return Against", doc.return_against, "/delivery-challan", doc.return_against, { optional: true }),
		fact("Purchase Order", doc.purchase_order, "/purchase-order", doc.purchase_order, { optional: true }),
		fact("GRN source", doc.goods_received_note, "/goods-received-note", doc.goods_received_note, { optional: true }),
		fact("DC Close", doc.delivery_challan_close, "/delivery-challan-close", doc.delivery_challan_close, { optional: true }),
		fact("Comments", doc.comments, null, null, { optional: true })]
}

export const itemColumns = [
	{ key: "item", label: "Item", doctype: "Item" }, { key: "received_type", label: "Received type" },
	{ key: "qty", label: "Sent", numeric: true }, { key: "rate", label: "Rate", money: true },
	{ key: "amount", label: "Value", money: true },
	{ key: "transferred_qty", label: "Transferred", numeric: true, internalOnly: true },
	{ key: "returned_qty", label: "Returned", numeric: true, internalOnly: true },
	{ key: "pending_in_transit", label: "Pending in transit", numeric: true, internalOnly: true },
]

export function itemRows(preview) {
	const is_internal = Number(preview?.doc?.is_internal_transfer)
	return itemTableRows(rows(preview).map((row) => ({ ...row,
		pending_in_transit: is_internal ? pendingTransferQuantity(row) : null,
		transferred_qty: is_internal ? row.transferred_qty : "—", returned_qty: is_internal ? row.returned_qty : "—",
	})), itemColumns)
}

export const planColumns = [
	{ key: "item", label: "Planned Item", doctype: "Item" }, { key: "received_type", label: "Received type" },
	{ key: "qty", label: "Qty", numeric: true }, { key: "uom", label: "UOM" },
]

export function planRows(preview) { return itemTableRows(preview?.extra?.plan_rows || [], planColumns) }

export function progress() { return null }
