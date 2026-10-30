import { documentModule } from "../documents/registry.js"
import { bookManifest } from "../books/manifest.js"

export function connectedDocuments(doc, meta) {
	const routes = Object.fromEntries(bookManifest.map((book) => [book.doctype, book.routePath]))
	routes["MGK Delivery Challan Close"] = "/delivery-challan-close"
	return meta.fields.filter((field) => field.fieldtype === "Link" && routes[field.options] && doc[field.fieldname])
		.map((field) => ({ label: field.label, doctype: field.options, name: doc[field.fieldname], to: `${routes[field.options]}/${encodeURIComponent(doc[field.fieldname])}` }))
}

export const summaryFields = ["total_qty", "total_output_qty", "total_amount", "total_declared_value", "total_dc_value",
	"net_total", "total_cgst", "total_sgst", "total_igst", "total_tax", "taxes", "grand_total"]
export const detailCompanionFields = { supplier_address: ["address_display"], contact_person: ["contact_display", "contact_mobile"] }
export const statusFields = ["status", "amended_from", "close_status", "reopen_status"]

export function documentLayout(doctype, meta) {
	const module = documentModule(doctype)
	const layout = module.layout
	const byName = Object.fromEntries(meta.fields.map((field) => [field.fieldname, module.fieldOverrides?.(field) || field]))
	const excluded = new Set([...layout.paperFields, ...summaryFields, ...statusFields,
		...Object.values(detailCompanionFields).flat(), "items", "outputs", "item_html", "item_details", "purchase_invoice", "delivery_challan_close",
		...(doctype === "MGK Delivery Challan" ? ["is_return"] : [])])
	const panelNames = [...new Set([...layout.panelFields, ...meta.fields.map((field) => field.fieldname)])].filter((name) => !excluded.has(name))
	const panel = panelNames.map((name) => byName[name]).filter(Boolean).map((field) => doctype === "MGK Delivery Challan" && field.fieldname === "return_against"
		? { ...field, depends_on: "eval:!!Number(doc.is_return)", read_only: 1 } : field)
	return { ...layout, paper: layout.paperFields.map((name) => byName[name]).filter(Boolean), panel }
}
