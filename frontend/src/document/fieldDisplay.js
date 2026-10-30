import { detailCompanionFields } from "./documentLayout.js"

export function plainText(value) {
	return String(value || "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "").trim()
}

export function companionText(field, doc) {
	return (detailCompanionFields[field.fieldname] || []).map((name) => plainText(doc[name])).filter(Boolean).join("\n")
}

export function formatFieldValue(field, value) {
	if (value == null || value === "") return "—"
	if (field.fieldtype === "Check") return Number(value) ? "Yes" : "No"
	if (["Currency", "Float", "Int", "Percent"].includes(field.fieldtype)) {
		const precision = field.fieldtype === "Currency" ? 2 : field.precision == null || field.precision === "" ? 6 : Number(field.precision)
		return Number(value).toLocaleString("en-IN", { minimumFractionDigits: field.fieldtype === "Currency" ? precision : 0,
			maximumFractionDigits: field.fieldtype === "Int" ? 0 : precision })
	}
	return String(value)
}
