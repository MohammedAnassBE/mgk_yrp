const tableTypes = new Set(["Table", "Table MultiSelect"])
const layoutTypes = new Set(["Section Break", "Column Break", "Tab Break", "Attachment Gallery", "HTML", "Button", "Image", "Fold", "Heading"])
const numericTypes = new Set(["Check", "Int", "Float", "Currency", "Percent"])
const scrub = (value) => String(value || "").toLowerCase().replaceAll(" ", "_").replaceAll("-", "_")
const hasValue = (value) => value !== undefined && value !== null && value !== ""
const asList = (value) => (Array.isArray(value) ? value : [value]).filter(hasValue)

function linkPermissions(field, doctype, boot) {
	if (field.ignore_user_permissions || field.options === "User") return []
	return (boot.user?.user_permissions?.[field.options] || [])
		.filter((permission) => !permission.applicable_for || permission.applicable_for === doctype)
}

function linkDefault(field, permissions, defaults) {
	if (field.read_only || field.options === "User") return undefined
	const preferred = permissions.find((permission) => permission.is_default)
	if (preferred) return preferred.doc
	if (permissions.length === 1) return permissions[0].doc
	const allowed = (value) => !permissions.length || permissions.some((permission) => permission.doc === value)
	const candidates = asList(defaults[field.options] ?? defaults[scrub(field.options)])
		.filter(allowed)
	if (!field.ignore_user_permissions && candidates.length === 1) return candidates[0]
	return asList(defaults[field.fieldname]).find(allowed)
}

function localTimestamp(now) {
	const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
		.map((part, index) => index ? String(part).padStart(2, "0") : part).join("-")
	return { date, time: now.toTimeString().slice(0, 8) }
}

function systemTimestamp(now, boot) {
	const timeZone = boot.sysdefaults?.time_zone || boot.defaults?.time_zone
	if (!timeZone) {
		const { date, time } = localTimestamp(now)
		return `${date} ${time}`
	}
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now)
	const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
	return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`
}

function bootDocumentDefault(field, defaults, boot, parentDoc) {
	const reference = field.default.slice(1)
	const name = parentDoc ? parentDoc[scrub(reference)] : defaults[scrub(reference)]
	return boot.docs?.find((doc) => doc.doctype === field.default && doc.name === name)?.[field.fieldname]
}

function fieldDefault(field, meta, context) {
	const { boot, defaults, now, parentDoc } = context
	const value = String(field.default)
	if (value === "__user" || value.toLowerCase() === "user") return boot.user?.name || defaults.user
	if (value === "user_fullname") return boot.user?.full_name || [boot.user?.first_name, boot.user?.last_name].filter(Boolean).join(" ")
	if (value === "Today") return localTimestamp(now).date
	if (value.toLowerCase() === "now") return field.fieldtype === "Time" ? localTimestamp(now).time : systemTimestamp(now, boot)
	if (value.startsWith(":")) return bootDocumentDefault(field, defaults, boot, parentDoc)
	return field.fieldname === meta.title_field ? undefined : field.default
}

function defaultValue(field, meta, context) {
	if (tableTypes.has(field.fieldtype)) return []
	const isLink = field.fieldtype === "Link"
	const permissions = isLink ? linkPermissions(field, meta.name, context.boot) : []
	let value = isLink ? linkDefault(field, permissions, context.defaults) : undefined
	if (hasValue(field.default)) {
		const explicit = fieldDefault(field, meta, context)
		if (!isLink || !permissions.length || permissions.some((permission) => permission.doc === explicit)) value = explicit
	}
	return typedDefault(field, value)
}

function typedDefault(field, value) {
	if (!hasValue(value) && field.fieldtype === "Select" && typeof field.options === "string"
		&& !["[Select]", "Loading..."].includes(field.options)) value = field.options.split("\n")[0]
	if (numericTypes.has(field.fieldtype)) return Number(value) || 0
	return value
}

export function metaDefaults(meta, now = new Date(), boot = globalThis.window?.frappe?.boot || {}, parentDoc) {
	const doc = { doctype: meta.name, docstatus: 0, __islocal: 1 }
	const defaults = { ...boot.sysdefaults, ...boot.defaults, ...boot.user?.defaults }
	for (const field of meta.fields || []) {
		if (layoutTypes.has(field.fieldtype) || field.no_default) continue
		const value = defaultValue(field, meta, { boot, defaults, now, parentDoc })
		if (value !== undefined && value !== null) doc[field.fieldname] = value
	}
	return doc
}
