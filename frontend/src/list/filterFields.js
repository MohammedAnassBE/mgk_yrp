import { scalarFields } from "./listColumns.js"

export const conditions = [
	["=", "Equals"], ["!=", "Not Equals"], ["like", "Like"], ["not like", "Not Like"],
	["in", "In"], ["not in", "Not In"], ["is", "Is"], [">", "Greater Than"], ["<", "Less Than"],
	[">=", "Greater Than or Equal To"], ["<=", "Less Than or Equal To"], ["between", "Between"], ["timespan", "Timespan"],
]
const TREE_CONDITIONS = ["descendants of", "descendants of (inclusive)", "not descendants of", "ancestors of", "not ancestors of"]
const TEXT_INVALID = ["between", "timespan"]
const NUMBER_INVALID = ["like", "not like", "between", "in", "not in", "timespan"]
const EDITOR_INVALID = [...TEXT_INVALID, ">", "<", ">=", "<=", "in", "not in"]
const invalid = {
	Date: ["like", "not like"], Datetime: ["like", "not like", "in", "not in", "=", "!="],
	Data: TEXT_INVALID, Time: TEXT_INVALID, Currency: TEXT_INVALID, Color: TEXT_INVALID,
	Select: ["like", "not like", ...TEXT_INVALID], Link: [...TEXT_INVALID, ">", "<", ">=", "<="],
	Check: conditions.map(([value]) => value).filter((value) => value !== "="),
	Int: NUMBER_INVALID, Float: NUMBER_INVALID, Percent: NUMBER_INVALID, Rating: NUMBER_INVALID,
	Code: EDITOR_INVALID, Password: EDITOR_INVALID, "HTML Editor": EDITOR_INVALID, "Markdown Editor": EDITOR_INVALID,
}
export const timespans = [
	"last 7 days", "last 14 days", "last 30 days", "last 90 days", "last week", "last month", "last quarter", "last 6 months", "last year",
	"yesterday", "today", "tomorrow", "this week", "this month", "this quarter", "this year",
	"next 7 days", "next 14 days", "next 30 days", "next week", "next month", "next quarter", "next 6 months", "next year",
]

export function fieldConditions(field = {}) {
	const allowed = conditions.filter(([value]) => !(invalid[field.fieldtype] || TEXT_INVALID).includes(value))
	const nested = globalThis.window?.frappe?.boot?.nested_set_doctypes || []
	if (field.fieldtype === "Link" && nested.includes(field.options)) return [...allowed, ...TREE_CONDITIONS.map((value) => [value, value])]
	return allowed
}

export function filterFields(meta) {
	return [
		{ fieldname: "name", fieldtype: "Data", label: "ID" },
		{ fieldname: "docstatus", fieldtype: "Select", label: "Document Status", options: "", choices: [[0, "Draft"], [1, "Submitted"], [2, "Cancelled"]], in_standard_filter: 1 },
		{ fieldname: "creation", fieldtype: "Datetime", label: "Created On" },
		{ fieldname: "modified", fieldtype: "Datetime", label: "Last Updated" },
		...scalarFields(meta),
	]
}

export function selectChoices(field) {
	if (field.choices) return field.choices
	if (field.fieldtype === "Check") return [[1, "Yes"], [0, "No"]]
	return String(field.options || "").split("\n").filter(Boolean).map((value) => [value, value])
}

export function inputType(field = {}) {
	if (["Int", "Float", "Currency", "Percent", "Duration", "Rating"].includes(field.fieldtype)) return "number"
	return { Date: "date", Datetime: "datetime-local", Time: "time" }[field.fieldtype] || "text"
}

export function filterTuples(rows, fields) {
	return rows.map((row) => {
		const field = fields.find((candidate) => candidate.fieldname === row.field)
		if (!field || !fieldConditions(field).some(([value]) => value === row.operator)) throw new Error("Choose a valid field and condition for every filter.")
		let value = row.value
		if (["in", "not in"].includes(row.operator)) value = String(value).split(",").map((part) => part.trim()).filter(Boolean)
		if (row.operator === "between") value = [row.value, row.end]
		if (value === "" || value == null || (Array.isArray(value) && (!value.length || value.some((part) => !part)))) throw new Error(`Enter a value for ${field.label}.`)
		if ((inputType(field) === "number" || field.fieldtype === "Check") && !Array.isArray(value) && row.operator !== "is") {
			value = Number(value)
			if (!Number.isFinite(value)) throw new Error(`Enter a number for ${field.label}.`)
		}
		if (["Date", "Datetime"].includes(field.fieldtype) && row.operator === "between" && value[0] > value[1]) throw new Error("The range end must follow its start.")
		return [row.field, row.operator, value]
	})
}
