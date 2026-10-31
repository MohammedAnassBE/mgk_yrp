import { formatDate } from "../../shared/formatDate.js"
export function summary(doc) {
	const fields = [["Supplier", "supplier"], ["Against", "against"], ["Bill No", "bill_no"], ["Bill Date", "bill_date"],
		["GST type", "tax_type"], ["Supplier GSTIN", "supplier_gstin"], ["Company GSTIN", "company_gstin"]]
	const totals = [["Net total", "net_total"], ["CGST", "total_cgst"], ["SGST", "total_sgst"], ["IGST", "total_igst"], ["Grand total", "grand_total"]]
	return { title: "Bill summary", lines: [
		...fields.map(([label, field]) => ({ label, value: field === "bill_date" ? formatDate(doc[field]) : doc[field] })),
		...totals.map(([label, field]) => ({ label, value: doc[field] || 0, money: true })),
	], checklist: [
		{ label: "Check supplier and receipt type", complete: Boolean(doc.supplier && doc.against) },
		{ label: "Fetch the billed GRN rows", complete: Boolean(doc.items?.length) },
	] }
}

export function viewFacts(doc) {
	return [["Supplier", doc.supplier], ["Against", doc.against], ["Bill No", doc.bill_no], ["Bill Date", formatDate(doc.bill_date)],
		["Posting Date", formatDate(doc.posting_date)], ["GST type", doc.tax_type], ["Supplier GSTIN", doc.supplier_gstin],
		["Company GSTIN", doc.company_gstin]].map(([label, value]) => ({ label, value }))
}
