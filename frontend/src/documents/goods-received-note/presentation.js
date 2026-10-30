import { statusPill } from "../../list/statusPill.js"
import { purchaseOrderFilters } from "./fieldEvents.js"

export function summary(doc, itemCount = doc.items?.length || 0) {
	return { title: "Receipt summary", lines: [{ label: "Source", value: doc.against_purchase_order ? doc.purchase_order || "Purchase Order" : "Job Work" },
		{ label: "Supplier", value: doc.supplier }, { label: "Warehouse", value: doc.warehouse },
		{ label: "Items", value: itemCount }, { label: "Received quantity", value: doc.total_qty || 0 },
		{ label: "Amount", value: doc.total_amount || 0, money: true }],
		checklist: [
			{ label: "Check the receipt source and supplier", complete: Boolean(doc.supplier && (!doc.against_purchase_order || doc.purchase_order)) },
			{ label: "Check the receiving warehouse", complete: Boolean(doc.warehouse) },
			{ label: "Enter only the quantities received now", complete: itemCount > 0 && Number(doc.total_qty) > 0 },
		] }
}

export function viewFacts(doc) {
	const source = doc.against_purchase_order ? { label: "Source PO", value: doc.purchase_order,
		doctype: "MGK Purchase Order", to: `/purchase-order/${encodeURIComponent(doc.purchase_order)}` } : { label: "Source", value: "Job Work" }
	return [source, { label: "Supplier", value: doc.supplier }, { label: "Posting date", value: doc.posting_date },
		{ label: "Posting time", value: doc.posting_time }, { label: "Delivery location", value: doc.delivery_location },
		{ label: "Warehouse", value: doc.warehouse },
		...(doc.delivery_challans || []).map((row) => ({ label: "Delivery Challan", value: row.delivery_challan,
			doctype: "MGK Delivery Challan", to: `/delivery-challan/${encodeURIComponent(row.delivery_challan)}` })),
		{ label: "Billing state", value: statusPill(doc.doctype, doc).label },
		...(doc.purchase_invoice ? [{ label: "Purchase Invoice", value: doc.purchase_invoice, doctype: "MGK Purchase Invoice",
			to: `/billing/${encodeURIComponent(doc.purchase_invoice)}` }] : [])]
}

export async function loadPresentation(doc, { read, can }) {
	const [invoice, count] = await Promise.all([
		doc.purchase_invoice && can("MGK Purchase Invoice") ? read("frappe.client.get_value", {
			doctype: "MGK Purchase Invoice", filters: { name: doc.purchase_invoice }, fieldname: "docstatus",
		}) : null,
		Number(doc.docstatus) === 0 && doc.against_purchase_order && can("MGK Purchase Order") ? read("mgk_yrp.web.list_counts.get_counts", {
			doctype_filter_sets: [{ doctype: "MGK Purchase Order", filters: Object.entries(purchaseOrderFilters(doc))
				.map(([key, value]) => Array.isArray(value) ? [key, ...value] : [key, "=", value]) }],
		}) : null,
	])
	return { purchase_invoice_docstatus: invoice?.docstatus,
		fieldHints: count ? { purchase_order: `${count[0]} open Purchase Orders${doc.supplier ? ` for ${doc.supplier}` : ""}` } : {} }
}
