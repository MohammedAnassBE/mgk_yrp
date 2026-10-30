const currency = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value) || 0)

export function intro(doc, money = currency) {
	if (["Reversing", "Reopening"].includes(doc.reopen_status)) return {
		text: "Reversing valuation; consumption will be cancelled when the reversal completes.", severity: "warn",
	}
	if (doc.reopen_status === "Reopened") return { text: "Delivery Challan reopened.", severity: "success" }
	const draft = Number(doc.docstatus) === 0
	if (doc.outputs?.length) return { text: `${draft ? "Adds" : "At close: added"} ${money(doc.value_per_unit)} per ${doc.output_stock_uom} to ${doc.outputs.length} GRN rows`, severity: "info" }
	return { text: draft ? `No linked GRN: ${money(doc.loss_value)} will be written off`
		: `At close: ${money(doc.loss_value)} was written off (no linked GRN)`, severity: "info" }
}

export function valuationChip(doc) {
	const status = doc.__onload?.valuation_status
	return status ? { label: `Valuation: ${status}`, className: ["Completed", "Reversed"].includes(status) ? "status-completed" : "status-pending" } : null
}

export function summary(doc) {
	return { title: "Close summary", lines: [
		{ label: "DC value", value: doc.total_dc_value, money: true },
		{ label: "Output quantity", value: doc.total_output_qty },
		{ label: "Output stock UOM", value: doc.output_stock_uom },
		{ label: Number(doc.docstatus) === 0 ? "Value Per Unit" : "Value Per Unit at Close", value: doc.value_per_unit, money: true },
		...(Number(doc.docstatus) === 0 ? [] : [{ label: "Total Value Gap", value: doc.total_value_gap, money: true }]),
		{ label: "Loss value", value: doc.loss_value, money: true },
	], checklist: [] }
}
