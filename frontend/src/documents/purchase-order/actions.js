import { makeGoodsReceivedNote } from "../goods-received-note/fieldEvents.js"

export function actions(doc, can) {
	if (Number(doc.docstatus) !== 1 || !(doc.items || []).some((row) => Number(row.pending_qty) > 0)
		|| !can("MGK Goods Received Note", "create")) return []
	const result = [{ key: "create-grn", label: "Create GRN", method: makeGoodsReceivedNote, route: "/goods-received-note" }]
	if (!doc.deliver_to_supplier || can("MGK Delivery Challan", "create")) result.push({
		key: "mark-as-received", label: "Mark as Received",
		confirm: receiptConfirmation, run: receivePurchaseOrder,
	})
	return result
}

function receiptConfirmation(doc) {
	return doc.deliver_to_supplier
		? `Create and submit a GRN for the full pending quantity at Head Office, then a Delivery Challan from Head Office to ${doc.delivery_location || ""} for process ${doc.process_name || ""}?`
		: `Create and submit a GRN for the full pending quantity at ${doc.delivery_location || ""}?`
}

async function receivePurchaseOrder({ doc }, { call }) {
	const result = await call("mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.mark_as_received", { source_name: doc.name })
	const links = [{ label: result.goods_received_note, to: `/goods-received-note/${encodeURIComponent(result.goods_received_note)}` }]
	if (result.delivery_challan) links.push({ label: result.delivery_challan, to: `/delivery-challan/${encodeURIComponent(result.delivery_challan)}` })
	return { message: "Created and submitted:", links }
}
