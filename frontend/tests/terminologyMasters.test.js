import test from "node:test"
import assert from "node:assert/strict"
import { createRouter, createMemoryHistory } from "vue-router"
import { mountComponent, nodes, settle, textContent } from "./helpers/component.js"
import { defaultTerms } from "./helpers/terms.js"
import { clearReadCaches } from "../src/api/client.js"
import { realtime } from "../src/realtime/socket.js"
import { setLanguage } from "../src/shell/displayLanguage.js"
import { setTerms } from "../src/shell/terminology.js"
import { getMaster } from "../src/masters/mastersConfig.js"
import { FakeSocket } from "./helpers/fakeSocket.js"

const dimension = { fieldname: "received_type", label: "Received Type", options: "YRP Received Type", mandatory: 1 }

function environment(doctype) {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	Object.assign(realtime, { socket: null, pending: null, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	const permissions = Object.fromEntries(["read", "write", "create", "delete"].map((permission) => [`can_${permission}`, [doctype, "Address", "Contact", "Item"]]))
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", ...permissions }, terms: defaultTerms() } }, addEventListener() {}, removeEventListener() {} }
	setTerms(null)
	return () => { globalThis.window = original.window; globalThis.fetch = original.fetch; Object.assign(realtime, original.realtime); clearReadCaches(); setLanguage("en") }
}

async function mountItemMaster() {
	const master = getMaster("items")
	const meta = { name: "Item", fields: [{ fieldname: "item_name", label: "Item Name", fieldtype: "Data" }] }
	globalThis.fetch = async (url) => {
		const response = url.includes("getdoctype") ? { docs: [meta] } : { message: [] }
		return { ok: true, status: 200, json: async () => structuredClone(response) }
	}
	const router = createRouter({ history: createMemoryHistory(), routes: ["/manage/:master/new", "/:pathMatch(.*)*"].map((path) => ({ path, component: { render: () => null } })) })
	await router.push(`${master.route}/new`)
	const page = await mountComponent("../../src/masters/MasterEntry.vue", { master }, [router])
	await settle()
	return page
}

const heading = (root) => textContent(nodes(root, (node) => node.tag === "h1")[0])
const kicker = (root) => textContent(nodes(root, (node) => node.props.class === "book-entry-kicker")[0])
const sectionTitles = (root) => nodes(root, (node) => node.tag === "h2").map(textContent)

test("master form heading, sections and buttons follow the display language", async () => {
	const restore = environment("Item")
	try {
		setLanguage("ta")
		let page = await mountItemMaster()
		try {
			assert.equal(heading(page.root), "புதிய பொருள் உருவாக்கு")
			assert.equal(kicker(page.root), "பொருள் மாஸ்டர்")
			assert.ok(sectionTitles(page.root).includes("புதிய பதிவு"))
			assert.match(textContent(page.root), /தேவையான புலங்களை நிரப்பவும்/)
		} finally { page.close() }
		setLanguage("en")
		page = await mountItemMaster()
		try {
			assert.equal(heading(page.root), "Create a new item")
			assert.equal(kicker(page.root), "Item Master")
			assert.match(textContent(page.root), /Complete the required fields/)
		} finally { page.close() }
	} finally { restore() }
})

function editorFetch() {
	globalThis.fetch = async (url) => {
		const method = new URL(url, "http://site").pathname.split("/").at(-1)
		let message = []
		if (method === "frappe.desk.form.load.getdoctype") return { ok: true, status: 200, json: async () => ({ docs: [{ name: "Item" }] }) }
		if (method === "mgk_yrp.stock.item_editor.get_editor_context") message = { defaults: {}, po_entries: [] }
		else if (method === "yrp.stock.api.get_stock_dimensions_for_ui") message = [dimension]
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
}

async function mountEditor() {
	const page = await mountComponent("../../src/item-editor/MgkItemEditor.vue", {
		doc: { doctype: "MGK Purchase Order", docstatus: 0 }, editable: true,
		itemDetails: [{ attributes: [], items: [{ name: "Yarn", attributes: {}, dimensions: {}, default_uom: "Kg", values: { default: { qty: 2, rate: 3, uom: "Kg" } } }] }],
	})
	await settle(); await settle()
	return page
}

test("item editor headers, entry heading and buttons follow the display language", async () => {
	const restore = environment("MGK Purchase Order")
	editorFetch()
	try {
		setLanguage("ta")
		let page = await mountEditor()
		try {
			const headers = nodes(page.root, (node) => node.tag === "th").map(textContent)
			for (const word of ["பொருள்", "அலகு", "விலை", "தொகை", "செயல்கள்"]) assert.ok(headers.includes(word), word)
			assert.ok(nodes(page.root, (node) => node.tag === "h4").map(textContent).includes("பொருள் சேர்"))
		} finally { page.close() }
		setLanguage("en")
		page = await mountEditor()
		try {
			const headers = nodes(page.root, (node) => node.tag === "th").map(textContent)
			for (const word of ["Item", "UOM", "Rate", "Amount", "Actions"]) assert.ok(headers.includes(word), word)
			assert.ok(nodes(page.root, (node) => node.tag === "h4").map(textContent).includes("Add item"))
		} finally { page.close() }
	} finally { restore() }
})
