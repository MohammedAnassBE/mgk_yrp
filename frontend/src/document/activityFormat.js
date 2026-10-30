export function formatDisplayDatetime(value) {
	if (!value) return ""
	const date = new Date(String(value).replace(" ", "T"))
	return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
}

export function isSavedDocumentName(name) { return Boolean(name) && !String(name).startsWith("new-") }
export function activityRefreshKey(record) { return record?.modified || `${record?.docstatus}|${record?.status}` }
const text = (value) => ({ text: String(value) })
const strong = (value) => ({ text: String(value), strong: true })
function display(value, fieldtype) {
	if (value === null || value === undefined || value === "") return "(empty)"
	if (fieldtype === "Check") return Number(value) ? "Yes" : "No"
	return value
}
function changes(rows) {
	return rows.flatMap((row, index) => [...(index ? [text(", ")] : []), strong(row.label), text(" from "), strong(display(row.old, row.fieldtype)), text(" to "), strong(display(row.new, row.fieldtype))])
}
function counts(rows, verb, preposition) {
	return (rows || []).map((row) => [text(`${verb} ${row.count} row${row.count === 1 ? '' : 's'} ${preposition} `), strong(row.table)])
}
export function describeActivityEntry(entry) {
	const events = (entry.events || []).map((event) => event === "amended"
		? [text("amended this from "), strong(entry.amended_from)]
		: [text(`${event} this document`), ...(entry.via ? [text(" via "), strong(entry.via)] : [])])
	return [...events, ...(entry.changes?.length ? [[text("changed "), ...changes(entry.changes)]] : []),
		...counts(entry.rows_added, "added", "to"), ...counts(entry.rows_removed, "removed", "from"),
		...(entry.row_changes || []).map((row) => [text(`changed ${row.table} row #${row.row}: `), ...changes(row.changes)])]
}
