import { formatDate, formatDatetime } from "../shared/formatDate.js"
import { detailCompanionFields } from "./documentLayout.js"
import { displayName } from "../shell/displayLanguage.js"

export function plainText(value) {
	return String(value || "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "").trim()
}

export function companionText(field, doc) {
	return (detailCompanionFields[field.fieldname] || []).map((name) => plainText(doc[name])).filter(Boolean).join("\n")
}

export function formatFieldValue(field, value) {
	if (value == null || value === "") return "—"
	if (field.fieldtype === "Link") return displayName(field.options, value)
	if (field.fieldtype === "Check") return Number(value) ? "Yes" : "No"
	if (field.fieldtype === "Date") return formatDate(value)
	if (field.fieldtype === "Datetime") return formatDatetime(value)
	if (field.fieldtype === "Time") return String(value).split(".")[0]
	if (["Currency", "Float", "Int", "Percent"].includes(field.fieldtype)) {
		const precision = field.fieldtype === "Currency" ? 2 : field.precision == null || field.precision === "" ? 6 : Number(field.precision)
		return Number(value).toLocaleString("en-IN", { minimumFractionDigits: field.fieldtype === "Currency" ? precision : 0,
			maximumFractionDigits: field.fieldtype === "Int" ? 0 : precision })
	}
	return String(value)
}
