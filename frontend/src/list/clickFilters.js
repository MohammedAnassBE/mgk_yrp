import { formatDate } from "../shared/formatDate.js"

const CLICK_FILTER_FIELDTYPES = new Set(["Link", "Select", "Data", "Check", "Date"])
const DOCSTATUS_LABELS = ["Draft", "Submitted", "Cancelled"]
const DISABLED_DOCTYPES = ["Item", "Supplier", "Warehouse", "MGK Agent"]
const ALWAYS_ACTIVE_DOCTYPES = ["Address", "Contact", "YRP Process", "YRP Received Type"]

/** Desk's click-to-filter: an equality tuple for a cell value, or null when the column is not filterable. */
export function clickFilter(field, value) {
	if (!field?.fieldname || field.fieldname === "name" || !CLICK_FILTER_FIELDTYPES.has(field.fieldtype)) return null
	if (value === null || value === undefined || value === "") return null
	return [field.fieldname, "=", field.fieldtype === "Check" ? Number(value) : value]
}

/** The equality tuple behind the status pill `statusPill` shows for this row. */
export function statusFilter(doctype, row) {
	if (doctype === "User") return ["enabled", "=", Number(row.enabled) || 0]
	if (DISABLED_DOCTYPES.includes(doctype)) return ["disabled", "=", Number(row.disabled) || 0]
	if (ALWAYS_ACTIVE_DOCTYPES.includes(doctype)) return null
	if (doctype === "MGK Purchase Order") return row.status ? ["status", "=", row.status] : null
	if (doctype === "MGK Supplier Credit Debit") return row.entry_type ? ["entry_type", "=", row.entry_type] : null
	if (row.docstatus === undefined || row.docstatus === null) return null
	const docstatus = Number(row.docstatus)
	if (docstatus !== 1) return ["docstatus", "=", docstatus]
	if (Number(row.is_internal_transfer) && row.transfer_status) return ["transfer_status", "=", row.transfer_status]
	if (doctype === "MGK Goods Received Note") return null
	if (doctype === "MGK Delivery Challan Close" && ["Reversing", "Reopening", "Reopened"].includes(row.reopen_status)) return ["reopen_status", "=", row.reopen_status]
	if (doctype === "MGK Delivery Challan") return Number(row.is_return) ? ["is_return", "=", 1] : ["close_status", "=", row.close_status || "Open"]
	return ["docstatus", "=", docstatus]
}

/** `filters` with any equality filter on the same field replaced by `filter`. */
export function replaceEqualityFilter(filters, filter) {
	const [fieldname] = filter
	return [...(filters || []).filter(([field, operator]) => !(field === fieldname && operator === "=")), filter]
}

/** A readable `Label operator value` chip text; dates show as DD-MM-YYYY. */
export function filterLabel([fieldname, operator, value], fields) {
	const field = fields.find((candidate) => candidate.fieldname === fieldname) || (fieldname === "docstatus" ? { label: "Document Status" } : { label: fieldname })
	const show = (part) => {
		if (fieldname === "docstatus") return DOCSTATUS_LABELS[Number(part)] ?? String(part)
		if (field.fieldtype === "Check") return Number(part) ? "Yes" : "No"
		if (["Date", "Datetime"].includes(field.fieldtype)) return formatDate(part, { withTime: field.fieldtype === "Datetime" })
		return String(part)
	}
	if (operator === "between" && Array.isArray(value)) return `${field.label} between ${show(value[0])} and ${show(value[1])}`
	const text = Array.isArray(value) ? value.map(show).join(", ") : show(value)
	return `${field.label} ${operator} ${text}`
}
