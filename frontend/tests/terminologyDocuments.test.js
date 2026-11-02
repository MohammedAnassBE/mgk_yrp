import test from "node:test"
import assert from "node:assert/strict"
import { reactive } from "vue"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { defaultTerms } from "./helpers/terms.js"
import { clearReadCaches } from "../src/api/client.js"
import { setLanguage } from "../src/shell/displayLanguage.js"
import { setTerms } from "../src/shell/terminology.js"

const order = { doctype: "MGK Purchase Order", name: "PO-1", docstatus: 0 }
const book = { label: "Purchase Order", code: "PO", cover: "po" }
const permissions = Object.fromEntries(["create", "write", "submit", "cancel", "delete", "print"].map((key) => [`can_${key}`, [order.doctype]]))
const options = { formats: ["MGK Purchase Order"], default_format: "MGK Purchase Order", letter_heads: [], default_letter_head: "" }

async function inBoth(run, terms = defaultTerms()) {
	const old = { window: globalThis.window, fetch: globalThis.fetch }
	globalThis.window = { frappe: { boot: { user: permissions, terms } }, setTimeout: () => {}, open: () => ({}) }
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ message: options }) })
	setTerms(null)
	try {
		for (const language of ["en", "ta"]) {
			setLanguage(language)
			await run(language === "ta")
		}
	} finally {
		Object.assign(globalThis, old)
		setTerms(null)
		setLanguage("en")
		clearReadCaches()
	}
}

const texts = (root, tag) => nodes(root, (node) => node.tag === tag).map(textContent)

test("document toolbar buttons follow the display language", () => inBoth(async (tamil) => {
	const page = await mountComponent("../../src/document/DocumentActions.vue", reactive({ doc: { ...order, docstatus: 1 }, meta: { is_submittable: 1 } }))
	try {
		assert.deepEqual(texts(page.root, "button"), tamil ? ["அச்சிடு", "ரத்து செய்"] : ["Print", "Cancel"])
	} finally { page.close() }
}))

test("document header shows the book and status in Tamil", () => inBoth(async (tamil) => {
	const page = await mountComponent("../../src/document/DocumentHeader.vue", reactive({ book, doc: order, dirty: true }))
	try {
		const kicker = textContent(nodes(page.root, (node) => node.props.class === "book-entry-kicker")[0])
		for (const word of tamil ? ["கொள்முதல் ஆணை", "வரைவு", "சேமிக்கப்படவில்லை"] : ["Purchase Order", "Draft", "Unsaved"]) assert.ok(kicker.includes(word), kicker)
		assert.equal(textContent(nodes(page.root, (node) => node.tag === "h1")[0]), tamil ? "PO-1 புதுப்பி" : "Update PO-1")
	} finally { page.close() }
}))

test("print dialog labels and buttons follow the display language", () => inBoth(async (tamil) => {
	const page = await mountComponent("../../src/document/print/PrintDialog.vue", { doc: { ...order, docstatus: 1 }, onClose: () => {} })
	try {
		await settle()
		const text = textContent(page.root)
		for (const word of tamil ? ["அச்சு வடிவம்", "லெட்டர் ஹெட்"] : ["Print Format", "Letter Head"]) assert.ok(text.includes(word), text)
		assert.deepEqual(texts(page.root, "button"), tamil ? ["PDF ஆக சேமி", "அச்சிடு"] : ["Save as PDF", "Print"])
	} finally { page.close() }
}))

test("field labels from doctype meta translate generically, including an edited term", () => inBoth(async (tamil) => {
	const field = { fieldname: "supplier_bill_no", fieldtype: "Data", label: "Supplier Bill No" }
	const page = await mountComponent("../../src/document/fields/FieldControl.vue", { field, doc: {}, meta: {}, metas: [], user: { name: "Administrator" } })
	try {
		assert.equal(textContent(nodes(page.root, (node) => node.tag === "label")[0]).trim(), tamil ? "சப்ளையர் பில் எண்" : "Supplier Bill No")
	} finally { page.close() }
}, { ...defaultTerms(), "mgk.supplier_bill_no": { source: "Supplier Bill No", ta: "சப்ளையர் பில் எண்" } }))

test("document summary lines and checklist follow the display language", () => inBoth(async (tamil) => {
	const summary = { title: "Order summary", lines: [{ label: "Ordered quantity", value: 4 }], checklist: [{ label: "Enter ordered quantities and rates", complete: false }] }
	const page = await mountComponent("../../src/document/DocumentSummary.vue", { summary, editing: true, book })
	try {
		const text = textContent(page.root)
		for (const word of tamil ? ["ஆர்டர் சுருக்கம்", "ஆர்டர் அளவு", "சேமிப்பதற்கு முன்", "ஆர்டர் அளவுகள் மற்றும் விலைகளை உள்ளிடவும்"]
			: ["Order summary", "Ordered quantity", "Before saving", "Enter ordered quantities and rates"]) assert.ok(text.includes(word), text)
	} finally { page.close() }
}))
