import { formatDate } from "../../shared/formatDate.js"
import { displayName } from "../../shell/displayLanguage.js"
import { displayRows, fact, money, rows, total } from "../previewValues.js"

export function facts(doc, preview) {
	return [fact("PO Date", formatDate(doc.po_date)),
		fact("Deliver To", [displayName("Supplier", doc.delivery_location), displayName("Warehouse", doc.warehouse)].filter(Boolean).join(" / ")),
		...(Number(doc.deliver_to_supplier) ? [fact("Deliver to Supplier", "Yes")] : []),
		fact("Process", doc.process_name, null, null, { optional: true }),
		fact("Routing", doc.goods_routing), fact("Order Type", orderType(doc)),
		fact("Amount", money(doc.total_amount)), fact("Pending qty", total(rows(preview || { doc }), "pending_qty")),
		fact("Comments", doc.comments, null, null, { optional: true })]
}

function orderType(doc) {
	if (Number(doc.is_karigan_order)) return "Karigan"
	return Number(doc.is_salavai_cone_order) ? "Salavai Cone" : "Regular"
}

export const itemColumns = [
	{ key: "item", label: "Item" }, { key: "qty", label: "Ordered", numeric: true },
	{ key: "received_qty", label: "Received", numeric: true }, { key: "pending_qty", label: "Pending", numeric: true },
	{ key: "rate", label: "Rate", money: true }, { key: "amount", label: "Amount", money: true },
]

export function itemRows(preview) {
	return displayRows(rows(preview).map((row) => ({ ...row,
		item: [displayName("Item", row.item), row.received_type].filter(Boolean).join(" · "),
	})), itemColumns)
}

export function progress(doc, preview) {
	const items = rows(preview || { doc })
	const received = total(items, "received_qty")
	const ordered = total(items, "qty")
	return ordered > 0 && received !== "—" ? { label: "Received / ordered", value: received, max: ordered } : null
}
