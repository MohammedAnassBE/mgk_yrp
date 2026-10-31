import { displayRows, fact, money, rows } from "../previewValues.js"
import { pendingTransferQuantity, transferIntro } from "../shared/transit.js"

export function facts(doc) {
	return [fact("From → To", `${doc.from_location || doc.from_warehouse || "—"} → ${doc.to_location || doc.to_warehouse || "—"}`),
		fact("Process", Number(doc.is_internal_transfer) ? "Internal transfer" : doc.process_name),
		fact("Posting Date", doc.posting_date), fact("Vehicle", doc.vehicle_number),
		fact("Declared Value", money(doc.total_declared_value)), fact("Return Against", doc.return_against, "/delivery-challan"),
		fact("Purchase Order", doc.purchase_order, "/purchase-order"), fact("GRN source", doc.goods_received_note, "/goods-received-note"),
		fact("Plan", doc.mgk_process_planning), fact("Close status", doc.close_status, "/delivery-challan-close", doc.delivery_challan_close || null)]
}

export const itemColumns = [
	{ key: "item", label: "Item" }, { key: "received_type", label: "Received type" },
	{ key: "qty", label: "Sent", numeric: true }, { key: "rate", label: "Rate", money: true },
	{ key: "amount", label: "Value", money: true },
	{ key: "transferred_qty", label: "Transferred", numeric: true, internalOnly: true },
	{ key: "returned_qty", label: "Returned", numeric: true, internalOnly: true },
	{ key: "pending_in_transit", label: "Pending in transit", numeric: true, internalOnly: true },
]

export function itemRows(preview) {
	const is_internal = Number(preview?.doc?.is_internal_transfer)
	return displayRows(rows(preview).map((row) => ({ ...row,
		pending_in_transit: is_internal ? pendingTransferQuantity(row) : null,
		transferred_qty: is_internal ? row.transferred_qty : "—", returned_qty: is_internal ? row.returned_qty : "—",
	})), itemColumns)
}

export const planColumns = [
	{ key: "item", label: "Planned Item" }, { key: "received_type", label: "Received type" },
	{ key: "qty", label: "Qty", numeric: true }, { key: "uom", label: "UOM" },
]

export function planRows(preview) { return displayRows(preview?.extra?.plan_rows || [], planColumns) }

export function progress() { return null }

export function intro(preview) {
	return transferIntro({ ...preview?.doc, items: rows(preview) })?.text || null
}
