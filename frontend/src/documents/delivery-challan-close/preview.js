import { displayRows, fact, money } from "../previewValues.js"

export function facts(doc, preview) {
	return [fact("DC", doc.delivery_challan, "/delivery-challan"), fact("Process", preview?.extra?.process_name),
		fact("Total DC Value", money(doc.total_dc_value)), fact("Total Output Qty", doc.total_output_qty),
		fact("Value per Unit", money(doc.value_per_unit)), fact("Loss Value", money(doc.loss_value)),
		fact("Reopen status", doc.reopen_status, null, null, { optional: true })]
}

export const itemColumns = [
	{ key: "item", label: "Output Item" }, { key: "input_item", label: "Input Item" },
	{ key: "goods_received_note", label: "GRN", link: "/goods-received-note" }, { key: "stock_qty", label: "Qty", numeric: true },
	{ key: "allocation_weight", label: "Allocation weight", numeric: true },
	{ key: "allocated_value", label: "Allocated value", money: true }, { key: "allocated_rate", label: "Allocated rate", money: true },
]

export function itemRows(preview) { return displayRows(preview?.doc?.outputs ?? preview?.items ?? [], itemColumns) }

export function progress() { return null }
