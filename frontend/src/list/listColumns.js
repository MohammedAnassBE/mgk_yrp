import { callRead, callMethod } from "../api/client.js"

const METHOD = "yrp.yrp.doctype.yrp_user_listview.yrp_user_listview"
const EXCLUDED = new Set(["Section Break", "Column Break", "Tab Break", "HTML", "Button", "Table", "Table MultiSelect", "Heading", "Fold", "Image"])
const STANDARD = new Set(["name", "docstatus", "modified", "creation", "owner", "modified_by"])

export function listColumnMeta(meta) {
	if (!["Address", "Contact"].includes(meta.name)) return meta
	return { ...meta, fields: meta.fields.map((field) => field.fieldname === "links" ? { ...field, fieldtype: "Data", clientOnly: true } : field) }
}

export function scalarFields(meta) {
	return (meta.fields || []).filter((field) => field.fieldname && !field.hidden && !field.is_virtual && !EXCLUDED.has(field.fieldtype))
}

export function columnDraft(meta, defaults, saved, statusField) {
	const fields = scalarFields(meta).filter((field) => !STANDARD.has(field.fieldname) && field.fieldname !== statusField)
	const byName = new Map(fields.map((field) => [field.fieldname, field]))
	const order = Array.isArray(saved) ? saved : defaults.map((fieldname) => ({ fieldname, enabled: 1 }))
	const columns = order.filter((column) => byName.has(column.fieldname)).map((column) => ({ ...byName.get(column.fieldname), enabled: Boolean(Number(column.enabled)) }))
	const known = new Set(columns.map((column) => column.fieldname))
	return [...columns, ...fields.filter((field) => !known.has(field.fieldname)).map((field) => ({ ...field, enabled: false }))]
}

export function visibleColumns(draft, statusLabel = "Status") {
	return [
		{ fieldname: "name", label: "ID", fieldtype: "Data" },
		...draft.filter((column) => column.enabled),
		{ fieldname: "__status", label: statusLabel, indicator: true },
	]
}

export function getUserColumns(doctype) {
	return callRead(`${METHOD}.get_user_listview`, { doctype_name: doctype })
}

export function saveUserColumns(doctype, columns) {
	return callMethod(`${METHOD}.save_user_listview`, {
		doctype_name: doctype,
		columns: columns.map(({ fieldname, enabled }) => ({ fieldname, enabled: enabled ? 1 : 0 })),
	})
}

export function resetUserColumns(doctype) {
	return callMethod(`${METHOD}.reset_user_listview`, { doctype_name: doctype })
}
