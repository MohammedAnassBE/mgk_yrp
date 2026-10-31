export function statusPill(doctype, row) {
	if (doctype === "User") return Number(row.enabled) ? pill("Active", "active") : pill("Disabled", "disabled")
	if (["Item", "Supplier", "Warehouse", "MGK Agent"].includes(doctype)) return Number(row.disabled) ? pill("Disabled", "disabled") : pill("Active", "active")
	if (["Address", "Contact", "YRP Process", "YRP Received Type"].includes(doctype)) return pill("Active", "active")
	if (doctype === "MGK Purchase Order") {
		const classes = { Draft: "draft", "To Receive": "pending", "Partially Received": "partially-received", Completed: "completed", Cancelled: "cancelled" }
		return pill(row.status || "Draft", classes[row.status] || "draft")
	}
	if (doctype === "MGK Goods Received Note") {
		if (Number(row.docstatus) === 0) return pill("Draft", "draft")
		if (Number(row.docstatus) === 2) return pill("Cancelled", "cancelled")
		const transfer = transferPill(row)
		if (transfer) return transfer
		if (row.purchase_invoice && Number(row.purchase_invoice_docstatus) === 1) return pill("Billed", "completed")
		if (row.purchase_invoice && row.purchase_invoice_docstatus == null) return pill("Invoice Linked", "pending")
		return pill("To Bill", "pending")
	}
	if (doctype === "MGK Delivery Challan") {
		if (Number(row.docstatus) === 0) return pill("Draft", "draft")
		if (Number(row.docstatus) === 2) return pill("Cancelled", "cancelled")
		const transfer = transferPill(row)
		if (transfer) return transfer
		if (Number(row.is_return)) return pill("Return", "disabled")
		const classes = { Open: "open", Closed: "completed", Reopening: "pending" }
		return pill(row.close_status || "Open", classes[row.close_status] || "open")
	}
	if (doctype === "MGK Delivery Challan Close" && ["Reversing", "Reopening", "Reopened"].includes(row.reopen_status)) {
		return pill(row.reopen_status, row.reopen_status === "Reopened" ? "closed" : "pending")
	}
	return [pill("Draft", "draft"), pill("Submitted", "submitted"), pill("Cancelled", "cancelled")][Number(row.docstatus) || 0]
}

function pill(label, status) { return { label, className: `status-${status}` } }

function transferPill(row) {
	const classes = { "In Transit": "pending", "Partly Transferred": "partially-received", Transferred: "completed", Returned: "disabled" }
	return Number(row.is_internal_transfer) && classes[row.transfer_status] ? pill(row.transfer_status, classes[row.transfer_status]) : null
}

export function indicatorFields(doctype, canReadInvoice = false) {
	if (doctype === "User") return ["enabled"]
	if (["Item", "Supplier", "Warehouse", "MGK Agent"].includes(doctype)) return ["disabled"]
	if (doctype === "MGK Purchase Order") return ["status"]
	if (doctype === "MGK Delivery Challan") return ["is_return", "close_status", "is_internal_transfer", "transfer_status"]
	if (doctype === "MGK Goods Received Note") {
		return ["purchase_invoice", "is_internal_transfer", "transfer_status", ...(canReadInvoice ? ["purchase_invoice.docstatus as purchase_invoice_docstatus"] : [])]
	}
	return ["docstatus"]
}
