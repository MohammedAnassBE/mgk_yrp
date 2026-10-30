export const clone = (value) => JSON.parse(JSON.stringify(value))

function draftToken() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
	const bytes = new Uint8Array(16)
	globalThis.crypto.getRandomValues(bytes)
	bytes[6] = (bytes[6] & 15) | 64
	bytes[8] = (bytes[8] & 63) | 128
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
	return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
}

export function stageMappedDraft(doc, storage = window.sessionStorage) {
	const token = draftToken()
	storage.setItem(`mgk:draft:${token}`, JSON.stringify(doc))
	return token
}

export function readMappedDraft(token, doctype, storage = window.sessionStorage) {
	const raw = storage.getItem(`mgk:draft:${token}`)
	if (!raw) throw new Error("Draft expired — this draft is no longer available. Open it again from its source document.")
	const doc = JSON.parse(raw)
	if (doc.doctype !== doctype) throw new Error("This draft belongs to another book.")
	return clone(doc)
}

export function amendmentDraft(doc, metas = []) {
	const draft = clone(doc)
	const parentMeta = metas.find((meta) => meta.name === doc.doctype)
	for (const field of parentMeta?.fields || []) if (field.no_copy) delete draft[field.fieldname]
	for (const key of ["name", "docstatus", "amended_from", "creation", "owner", "modified", "modified_by", "__onload"]) delete draft[key]
	for (const rows of Object.values(draft).filter(Array.isArray)) {
		for (const row of rows) {
			for (const key of ["name", "parent", "docstatus", "creation", "modified", "owner", "modified_by"]) delete row[key]
			row.__islocal = 1
		}
	}
	draft.amended_from = doc.name
	draft.docstatus = 0
	draft.__islocal = 1
	return draft
}

export async function openMappedDraft(action, sourceName, { call, navigate, storage = window.sessionStorage, isCurrent = () => true }) {
	const doc = await call("frappe.model.mapper.make_mapped_doc", { method: action.method, source_name: sourceName })
	if (!isCurrent()) return
	const draft = stageMappedDraft(doc, storage)
	await navigate({ path: `${action.route}/new`, query: { draft } })
	return draft
}

