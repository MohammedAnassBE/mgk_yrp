import { conditionContext } from "./conditionContext.js"

const layoutTypes = new Set(["Section Break", "Column Break", "Tab Break", "HTML", "Button", "Fold", "Heading"])
const reportedConditions = new Set()

export function condition(expression, doc, options = {}) {
	if (!expression || !doc) return false
	try {
		if (typeof expression === "boolean") return expression
		if (typeof expression === "function") return Boolean(expression(doc))
		const source = expression.trim().replace(/[;\s]+$/, "")
		if (!source.startsWith("eval:")) return Array.isArray(doc[source]) ? Boolean(doc[source].length) : Boolean(doc[source])
		const context = conditionContext(doc, options)
		return Boolean(new Function(...Object.keys(context), `"use strict"; return (${source.slice(5)});`)(...Object.values(context)))
	} catch (cause) {
		reportCondition(expression, doc, options, cause)
		return false
	}
}

function reportCondition(expression, doc, options, cause) {
	const location = `${doc.doctype || options.doctype || "Unknown DocType"}.${options.fieldname || "Unknown field"}`
	const message = `Could not evaluate field condition: ${location}: ${expression}`
	if (reportedConditions.has(message)) return
	reportedConditions.add(message)
	console.error(message, cause)
}

export function levelPermission(meta, field, permission, user = globalThis.window?.frappe?.boot?.user || {}) {
	if (user.name === "Administrator") return true
	const roles = user.roles || globalThis.window?.frappe?.boot?.roles || []
	return (meta.permissions || []).some((row) => roles.includes(row.role)
		&& Number(row.permlevel || 0) === Number(field.permlevel || 0) && row[permission])
}

export function fieldState(field, doc, meta, user, parent = doc) {
	const options = { parent, doctype: meta.name, fieldname: field.fieldname }
	const visible = !layoutTypes.has(field.fieldtype) && !field.hidden
		&& (!field.depends_on || condition(field.depends_on, doc, options)) && levelPermission(meta, field, "read", user)
	const readOnly = Boolean(field.read_only || condition(field.read_only_depends_on, doc, options)
		|| !levelPermission(meta, field, "write", user) || Number(doc.docstatus) === 2
		|| (Number(doc.docstatus) === 1 && !field.allow_on_submit))
	return { visible, readOnly, required: Boolean(field.reqd || condition(field.mandatory_depends_on, doc, options)) }
}

export function isEmpty(value, field) {
	if (field.fieldtype === "Check") return !Number(value)
	return value == null || value === "" || (Array.isArray(value) && !value.length)
}

export function missingFields(fields, doc, meta, user) {
	return fields.filter((field) => {
		const state = fieldState(field, doc, meta, user)
		return state.visible && state.required && isEmpty(doc[field.fieldname], field)
	})
}

export function visibleFields(fields, doc, meta, user, parent = doc) {
	return fields.filter((field) => fieldState(field, doc, meta, user, parent).visible)
}
