import test from "node:test"
import assert from "node:assert/strict"
import { indicatorFields, statusPill } from "../src/list/statusPill.js"
import { facts } from "../src/documents/goods-received-note/preview.js"

test("PO Desk indicators map to MCY status classes (Desk red draft uses amber)", () => {
	for (const [status, expected] of [["Draft", "draft"], ["To Receive", "pending"], ["Partially Received", "partially-received"], ["Completed", "completed"], ["Cancelled", "cancelled"]]) {
		assert.deepEqual(statusPill("MGK Purchase Order", { status }), { label: status, className: `status-${expected}` })
	}
})

test("GRN follows Desk linked-invoice status including drafts, cancellations and restricted invoice access", () => {
	for (const [row, label, color] of [[{}, "To Bill", "pending"], [{ purchase_invoice: "PI-1", purchase_invoice_docstatus: 1 }, "Billed", "completed"], [{ purchase_invoice: "PI-1" }, "Invoice Linked", "pending"], [{ purchase_invoice: "PI-1", purchase_invoice_docstatus: 0 }, "To Bill", "pending"], [{ purchase_invoice: "PI-1", purchase_invoice_docstatus: 2 }, "To Bill", "pending"]]) {
		assert.deepEqual(statusPill("MGK Goods Received Note", row), { label, className: `status-${color}` })
	}
	assert.deepEqual(indicatorFields("MGK Goods Received Note", false), ["purchase_invoice", "is_internal_transfer", "transfer_status"])
	assert.deepEqual(indicatorFields("MGK Goods Received Note", true), ["purchase_invoice", "is_internal_transfer", "transfer_status", "purchase_invoice.docstatus as purchase_invoice_docstatus"])
})

test("GRN preview document status agrees with its billing fact and list pill", () => {
	for (const [status, label] of [[1, "Billed"], [0, "To Bill"], [2, "To Bill"], [undefined, "Invoice Linked"]]) {
		const doc = { docstatus: 1, purchase_invoice: "PI-1", ...(status === undefined ? {} : { purchase_invoice_docstatus: status }) }
		assert.equal(statusPill("MGK Goods Received Note", doc).label, label)
		assert.equal(facts(doc).find((fact) => fact.label === "Bill status").value, label)
	}
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

test("internal DC and GRN transfer indicators precede close, return and billing states", () => {
	const states = [["In Transit", "pending"], ["Partly Transferred", "partially-received"], ["Transferred", "completed"], ["Returned", "disabled"]]
	for (const doctype of ["MGK Delivery Challan", "MGK Goods Received Note"]) {
		assert.ok(indicatorFields(doctype).includes("is_internal_transfer"))
		assert.ok(indicatorFields(doctype).includes("transfer_status"))
		for (const [label, color] of states) {
			const row = { docstatus: 1, is_internal_transfer: "1", transfer_status: label, close_status: "Closed", is_return: 1,
				purchase_invoice: "PI-1", purchase_invoice_docstatus: 1 }
			assert.deepEqual(statusPill(doctype, row), { label, className: `status-${color}` })
			assert.equal(statusPill(doctype, { ...row, docstatus: 0 }).label, "Draft")
			assert.equal(statusPill(doctype, { ...row, docstatus: 2 }).label, "Cancelled")
			assert.notEqual(statusPill(doctype, { ...row, is_internal_transfer: "0" }).label, label)
		}
	}
})
