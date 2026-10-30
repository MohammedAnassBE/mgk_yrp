import { condition, fieldState } from "../document/fieldConditions.js"

const layoutTypes = new Set(["Section Break", "Column Break", "Tab Break", "HTML", "Button", "Fold", "Heading", "Image"])

function metaSections(master, meta, doc, user) {
	const sections = []
	let section = { key: "details", label: "Details", fields: [] }
	let tabHidden = false
	let sectionHidden = false
	for (const field of meta.fields || []) {
		const options = { doctype: meta.name, fieldname: field.fieldname }
		if (field.fieldtype === "Tab Break") tabHidden = Boolean(field.hidden || master.hiddenSections?.includes(field.fieldname) || (field.depends_on && !condition(field.depends_on, doc, options)))
		if (["Section Break", "Tab Break"].includes(field.fieldtype)) {
			sectionHidden = tabHidden || Boolean(field.hidden || master.hiddenSections?.includes(field.fieldname)
				|| (field.depends_on && !condition(field.depends_on, doc, options)))
			if (section.fields.length) sections.push(section)
			section = { key: field.fieldname, label: field.label || "Details", fields: [] }
		}
		if (layoutTypes.has(field.fieldtype) || sectionHidden || tabHidden) continue
		if (master.fields && !master.fields.includes(field.fieldname)) continue
		if (master.hideFormFields?.includes(field.fieldname) || master.hideChildTables?.includes(field.fieldname)) continue
		if (fieldState(field, doc, meta, user).visible) section.fields.push(configuredField(master, field))
	}
	if (section.fields.length) sections.push(section)
	return sections
}

function configuredField(master, field) {
	return { ...field, label: master.labels?.[field.fieldname] ?? field.label,
		description: master.help?.[field.fieldname] ?? field.description,
		boolLabels: master.boolLabels?.[field.fieldname] }
}

export function masterSections(master, meta, doc, user) {
	const sections = metaSections(master, meta, doc, user)
	if (!master.formGroups) return sections
	const fields = new Map(sections.flatMap((section) => section.fields).map((field) => [field.fieldname, field]))
	return master.formGroups.map((group, index) => ({ key: `master-${index}`, label: group.label,
		fields: (master.formOrder || group.fields).filter((name) => group.fields.includes(name) && fields.has(name)).map((name) => fields.get(name))
	})).filter((section) => section.fields.length)
}

export function masterHeading(master, doc, meta, isNew) {
	const title = [meta?.title_field, ...(master.titleFields || [])].map((field) => doc?.[field]).find((value) => String(value || "").trim()) || doc?.name
	return { kicker: `${master.entityLabel || master.doctype} Master`,
		title: isNew ? `Create a new ${(master.entityLabel || master.doctype).toLowerCase()}` : title,
		description: master.description }
}

export function disableField(meta) { return meta.fields.find((field) => ["disabled", "enabled"].includes(field.fieldname) && field.fieldtype === "Check") }

export function disabledValue(field, doc) {
	return field.fieldname === "disabled" ? Boolean(Number(doc.disabled)) : !Number(doc.enabled)
}

export function dynamicTarget(field, doc) { return field.fieldtype === "Dynamic Link" ? doc[field.options] || "" : field.options }

export function childChange(row, name, value, fields) {
	const patch = { [name]: value }
	for (const field of fields) if (field.fieldtype === "Dynamic Link" && field.options === name && row[name] !== value) patch[field.fieldname] = null
	return patch
}

export function dynamicLinkFields(meta, doctypes) {
	return { ...meta, fields: meta.fields.map((field) => field.fieldname === "link_doctype" && meta.name === "Dynamic Link"
		? { ...field, fieldtype: "Select", options: ["", ...doctypes].join("\n") } : field) }
}

export function partyLinkFilters(doctype, name) {
	return [["Dynamic Link", "link_doctype", "=", doctype], ["Dynamic Link", "link_name", "=", name]]
}

export function linkedPartyDraft(doctype, name) { return { links: [{ doctype: "Dynamic Link", link_doctype: doctype, link_name: name }] } }

export function partyReturnPath(master, name) {
	// Let query serialization encode spaces; keep reserved path characters escaped.
	return `${master.route}/${encodeURIComponent(name).replaceAll("%20", " ")}`
}

export function safeReturnPath(value) {
	return typeof value === "string" && /^\/manage\/[^/?#]+\/[^/?#]+$/.test(value) ? value.replaceAll(" ", "%20") : null
}
