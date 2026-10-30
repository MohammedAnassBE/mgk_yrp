import test from "node:test"
import assert from "node:assert/strict"
import { indicatorFields, statusPill } from "../src/list/statusPill.js"

test("PO Desk indicators map to MCY status classes (Desk red draft uses amber)", () => {
	for (const [status, expected] of [["Draft", "draft"], ["To Receive", "pending"], ["Partially Received", "partially-received"], ["Completed", "completed"], ["Cancelled", "cancelled"]]) {
		assert.deepEqual(statusPill("MGK Purchase Order", { status }), { label: status, className: `status-${expected}` })
	}
})

test("GRN follows Desk linked-invoice status including drafts, cancellations and restricted invoice access", () => {
	for (const [row, label, color] of [[{}, "To Bill", "pending"], [{ purchase_invoice: "PI-1", purchase_invoice_docstatus: 1 }, "Billed", "completed"], [{ purchase_invoice: "PI-1" }, "Invoice Linked", "pending"], [{ purchase_invoice: "PI-1", purchase_invoice_docstatus: 0 }, "To Bill", "pending"], [{ purchase_invoice: "PI-1", purchase_invoice_docstatus: 2 }, "To Bill", "pending"]]) {
		assert.deepEqual(statusPill("MGK Goods Received Note", row), { label, className: `status-${color}` })
	}
	assert.deepEqual(indicatorFields("MGK Goods Received Note", false), ["purchase_invoice"])
	assert.deepEqual(indicatorFields("MGK Goods Received Note", true), ["purchase_invoice", "purchase_invoice.docstatus as purchase_invoice_docstatus"])
})

test("draft and cancelled GRNs never display submitted billing state; DC drafts and cancellations override return/close state", () => {
	for (const doctype of ["MGK Goods Received Note", "MGK Delivery Challan"]) {
		const row = { purchase_invoice: "PI-1", purchase_invoice_docstatus: 1, is_return: 1, close_status: "Closed" }
		assert.deepEqual(statusPill(doctype, { ...row, docstatus: 0 }), { label: "Draft", className: "status-draft" })
		assert.deepEqual(statusPill(doctype, { ...row, docstatus: 2 }), { label: "Cancelled", className: "status-cancelled" })
	}
})

test("DC returns override close status; Closed is green per Desk", () => {
	for (const [row, label, color] of [[{ is_return: 1, close_status: "Closed" }, "Return", "disabled"], [{ close_status: "Open" }, "Open", "open"], [{ close_status: "Closed" }, "Closed", "completed"], [{ close_status: "Reopening" }, "Reopening", "pending"]]) {
		assert.deepEqual(statusPill("MGK Delivery Challan", row), { label, className: `status-${color}` })
	}
})

test("Billing uses Draft, Submitted and Cancelled document statuses", () => {
	for (const [docstatus, label, color] of [[0, "Draft", "draft"], [1, "Submitted", "submitted"], [2, "Cancelled", "cancelled"]]) {
		assert.deepEqual(statusPill("MGK Purchase Invoice", { docstatus }), { label, className: `status-${color}` })
	}
})
