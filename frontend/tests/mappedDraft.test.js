import test from "node:test"
import assert from "node:assert/strict"
import { readMappedDraft, stageMappedDraft, amendmentDraft } from "../src/document/mappedDraft.js"
import { metaDefaults } from "../src/document/newDocDefaults.js"
const storage = () => { const values = new Map(); return { setItem: (key, value) => values.set(key, value), getItem: (key) => values.get(key) } }

test("mapped drafts remain available across refreshes and reject missing or mismatched tokens", () => {
	const store = storage()
	const doc = { doctype: "MGK Purchase Order", items: [{ name: "new-row", qty: 2 }], custom: "keep" }
	const token = stageMappedDraft(doc, store)
	const read = readMappedDraft(token, doc.doctype, store)
	assert.deepEqual(read, doc)
	read.custom = "edit"
	assert.deepEqual(readMappedDraft(token, doc.doctype, store), doc)
	assert.throws(() => readMappedDraft("missing", doc.doctype, store), /no longer available/)
	assert.throws(() => readMappedDraft(token, "Other", store), /another book/)
})

test("mapped drafts can create UUIDs on an HTTP development site without crypto.randomUUID", () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID")
	Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true })
	try {
		const token = stageMappedDraft({ doctype: "PO" }, storage())
		assert.match(token, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
	} finally {
		if (descriptor) Object.defineProperty(globalThis.crypto, "randomUUID", descriptor)
		else delete globalThis.crypto.randomUUID
	}
})

test("new metadata defaults resolve Today, Now and numeric checks in local time", () => {
	const now = new Date(2026, 9, 29, 9, 8, 7)
	assert.deepEqual(metaDefaults({ name: "PO", fields: [
		{ fieldname: "date", fieldtype: "Date", default: "Today" }, { fieldname: "time", fieldtype: "Time", default: "Now" },
		{ fieldname: "flag", fieldtype: "Check", default: "0" }, { fieldname: "routing", fieldtype: "Select", default: "Direct" },
		{ fieldname: "items", fieldtype: "Table" },
	] }, now), { doctype: "PO", __islocal: 1, docstatus: 0, date: "2026-10-29", time: "09:08:07", flag: 0, routing: "Direct", items: [] })
})

test("amendment clears no_copy fields, onload and amendment chain while keeping rows", () => {
	const doc = { doctype: "PO", name: "PO-2", docstatus: 2, amended_from: "PO-1", status: "Cancelled", item_details: "stale", items: [{ name: "child", qty: 2, custom: true }] }
	const draft = amendmentDraft(doc, [{ name: "PO", fields: [{ fieldname: "status", no_copy: 1 }, { fieldname: "item_details", no_copy: 1 }] }])
	assert.equal(draft.name, undefined)
	assert.equal(draft.status, undefined)
	assert.equal(draft.item_details, undefined)
	assert.equal(draft.amended_from, "PO-2")
	assert.equal(draft.__islocal, 1)
	assert.deepEqual(draft.items, [{ qty: 2, custom: true, __islocal: 1 }])
})
