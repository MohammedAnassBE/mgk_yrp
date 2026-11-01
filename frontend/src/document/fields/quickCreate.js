import { getMeta } from "../../api/client.js"
import { hasPermission } from "../../permissions/usePermissions.js"
import { masters } from "../../masters/mastersConfig.js"
import { metaDefaults } from "../newDocDefaults.js"
import { fieldState, isEmpty } from "../fieldConditions.js"
import { linkDescription } from "../../list/linkOptions.js"

const masterFor = (doctype) => masters.find((master) => master.doctype === doctype)

export function quickCreateLabel(doctype) { return masterFor(doctype)?.entityLabel || doctype }

export async function canQuickCreate(doctype, can = hasPermission) {
	if (!doctype || !can(doctype, "create")) return false
	const meta = (await getMeta(doctype)).find((entry) => entry.name === doctype)
	return Boolean(meta && !meta.istable && !meta.issingle && !meta.is_submittable)
}

export function hasExactMatch(options, text) {
	const needle = String(text || "").trim().toLowerCase()
	return options.some((option) => [option.value, option.tamil, linkDescription(option)]
		.some((value) => String(value || "").trim().toLowerCase() === needle))
}

function titleFieldname(meta, master) {
	const names = new Set(meta.fields.map((field) => field.fieldname))
	const autonameField = meta.autoname?.startsWith("field:") ? meta.autoname.slice(6) : null
	const title = [...(master?.titleFields || []), meta.title_field, autonameField].find((name) => name && names.has(name))
	return title || (String(meta.autoname || "").toLowerCase() === "prompt" ? "name" : null)
}

function equalityFilters(filters, names) {
	const rows = Array.isArray(filters) ? filters.map((row) => row.length === 4 ? row.slice(1) : row)
		: Object.entries(filters || {}).map(([field, value]) => Array.isArray(value) ? [field, ...value] : [field, "=", value])
	return Object.fromEntries(rows.filter(([field, operator, value]) => operator === "=" && names.has(field) && ["string", "number"].includes(typeof value))
		.map(([field, , value]) => [field, value]))
}

function isShown(field, draft, meta, master, user, title) {
	if (field.fieldname === title) return true
	if (master && (!master.fields.includes(field.fieldname) || master.hideFormFields?.includes(field.fieldname))) return false
	const state = fieldState(field, draft, meta, user)
	return state.visible && state.required && !field.read_only && isEmpty(draft[field.fieldname], field)
}

export function quickCreateForm(doctype, docs, text, filters = {}, boot = globalThis.window?.frappe?.boot || {}) {
	const master = masterFor(doctype)
	const base = docs.find((entry) => entry.name === doctype)
	if (!base) throw new Error(`Metadata is missing for ${doctype}.`)
	const meta = { ...base, fields: base.fields.map((field) => ({ ...field, ...master?.fieldOverrides?.[field.fieldname],
		label: master?.labels?.[field.fieldname] ?? field.label })) }
	const title = titleFieldname(meta, master)
	const names = new Set(meta.fields.map((field) => field.fieldname))
	const draft = { ...metaDefaults(meta, new Date(), boot), ...master?.defaults, ...equalityFilters(filters, names), ...(title ? { [title]: text } : {}) }
	const fields = meta.fields.filter((field) => isShown(field, draft, meta, master, boot.user, title))
	if (title === "name") fields.unshift({ fieldname: "name", fieldtype: "Data", label: "Name", reqd: 1 })
	return { meta, metas: docs.map((entry) => entry.name === doctype ? meta : entry), fields, draft, title }
}

export function quickCreateDoc({ meta, title }, draft) {
	const autonameField = meta.autoname?.startsWith("field:") ? meta.autoname.slice(6) : null
	if (!autonameField || !title || !isEmpty(draft[autonameField], {})) return draft
	return { ...draft, [autonameField]: draft[title] }
}
