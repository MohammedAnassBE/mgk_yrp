import { makeGoodsReceivedNote } from "../goods-received-note/fieldEvents.js"

export function actions(doc, can) {
	return Number(doc.docstatus) === 1 && (doc.items || []).some((row) => Number(row.pending_qty) > 0)
		&& can("MGK Goods Received Note", "create")
		? [{ key: "create-grn", label: "Create GRN", method: makeGoodsReceivedNote, route: "/goods-received-note" }] : []
}
