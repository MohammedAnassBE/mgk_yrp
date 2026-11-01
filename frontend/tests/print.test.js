import test from "node:test"
import assert from "node:assert/strict"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { clearReadCaches, downloadPrintPdf } from "../src/api/client.js"
import { buildPrintPdfArgs, buildPrintUrl, canPrint, openPrintUrl, printAction } from "../src/document/print/print.js"
import { previewActions } from "../src/list/previewActions.js"

const order = { doctype: "MGK Purchase Order", name: "PO/26 # 1", docstatus: 1 }
const params = (overrides = {}) => new URL(buildPrintUrl({ doctype: order.doctype, name: order.name, format: "MGK A&B / PO", ...overrides }), "https://site").searchParams
const button = (root, label) => nodes(root, (node) => node.tag === "button" && textContent(node) === label)[0]

async function withBrowser(user, run, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
	const old = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
	const opened = [], requests = [], links = []
	globalThis.window = { frappe: { boot: { user } }, csrf_token: "token", setTimeout: () => {}, open: (...args) => { opened.push(args); return {} } }
	globalThis.document = { cookie: "", createElement: (tag) => { const link = { tag, click() { link.clicked = true } }; links.push(link); return link } }
	globalThis.fetch = async (url, options) => { requests.push([url, options]); return fetchImpl(url, options) }
	URL.createObjectURL = () => "blob:pdf"
	URL.revokeObjectURL = () => {}
	try { await run({ opened, requests, links }) } finally {
		Object.assign(globalThis, { window: old.window, document: old.document, fetch: old.fetch })
		URL.createObjectURL = old.create; URL.revokeObjectURL = old.revoke
		clearReadCaches()
	}
}

test("print URL targets Frappe's printview with encoded format, name and trigger_print", () => {
	const url = buildPrintUrl({ doctype: order.doctype, name: order.name, format: "MGK A&B / PO" })
	assert.ok(url.startsWith("/printview?"))
	assert.equal(params().get("doctype"), order.doctype)
	assert.equal(params().get("name"), order.name)
	assert.equal(params().get("format"), "MGK A&B / PO")
	assert.equal(params().get("trigger_print"), "1")
})

test("print URL sends the selected letter head or disables it", () => {
	assert.equal(params().get("no_letterhead"), "1")
	assert.equal(params().has("letterhead"), false)
	assert.equal(params({ letterHead: "MGK & Co" }).get("no_letterhead"), "0")
	assert.equal(params({ letterHead: "MGK & Co" }).get("letterhead"), "MGK & Co")
})

test("PDF args mirror the letter head selection", () => {
	assert.deepEqual(buildPrintPdfArgs({ doctype: "MGK Purchase Order", name: "PO-1", format: "Standard", letterHead: "" }),
		{ doctype: "MGK Purchase Order", name: "PO-1", format: "Standard", no_letterhead: 1 })
	assert.deepEqual(buildPrintPdfArgs({ doctype: "MGK Purchase Order", name: "PO-1", format: "F", letterHead: "MGK" }),
		{ doctype: "MGK Purchase Order", name: "PO-1", format: "F", no_letterhead: 0, letterhead: "MGK" })
})

test("print is offered only for saved documents the user may print", () => {
	const can = (doctype, permission) => permission === "print" && doctype === order.doctype
	assert.equal(canPrint(order, false, can), true)
	assert.equal(canPrint(order, true, can), false)
	assert.equal(canPrint({ ...order, name: "" }, false, can), false)
	assert.equal(canPrint({ ...order, doctype: "MGK Delivery Challan" }, false, can), false)
	assert.equal(canPrint(order, false, () => false), false)
})

test("preview Actions include Print only with print permission", () => {
	const labels = (can) => previewActions(order, { is_submittable: 1 }, can).map((action) => action.label)
	assert.ok(labels(() => true).includes("Print"))
	assert.ok(!labels((_doctype, permission) => permission !== "print").includes("Print"))
	assert.equal(typeof printAction.dialog, "function")
})

test("opening a print URL reports blocked pop-ups", async () => {
	await withBrowser({}, async ({ opened }) => {
		assert.equal(openPrintUrl("/printview?x"), true)
		assert.deepEqual(opened[0], ["/printview?x", "_blank"])
		globalThis.window.open = () => null
		assert.equal(openPrintUrl("/printview?x"), false)
	})
})

test("PDF download posts the print args to download_pdf and saves it under the document name", async () => {
	const response = { ok: true, status: 200, headers: { get: () => "" }, blob: async () => new Blob(["%PDF"]) }
	await withBrowser({}, async ({ requests, links }) => {
		const args = { doctype: "MGK Purchase Order", name: "PO 1/2", format: "Standard", no_letterhead: 1 }
		await downloadPrintPdf(args)
		assert.equal(requests[0][0], "/api/method/frappe.utils.print_format.download_pdf")
		assert.equal(requests[0][1].method, "POST")
		assert.deepEqual(JSON.parse(requests[0][1].body), args)
		assert.equal(links[0].download, "PO-1-2.pdf")
		assert.equal(links[0].clicked, true)
	}, async () => response)
	const failed = { ok: false, status: 500, json: async () => ({ _server_messages: JSON.stringify([JSON.stringify({ message: "wkhtmltopdf missing" })]) }) }
	await withBrowser({}, async ({ links }) => {
		await assert.rejects(downloadPrintPdf({ doctype: "MGK Purchase Order", name: "PO-1", format: "Standard" }), /wkhtmltopdf missing/)
		assert.deepEqual(links, [])
	}, async () => failed)
})

test("document toolbar shows Print only for saved documents with print permission", async () => {
	const props = { doc: order, meta: { is_submittable: 1 }, isNew: false, dirty: false, busy: false }
	for (const [user, isNew, expected] of [[{ can_print: [order.doctype] }, false, true], [{ can_print: [order.doctype] }, true, false], [{ can_print: [] }, false, false]]) {
		await withBrowser(user, async () => {
			const page = await mountComponent("../../src/document/DocumentActions.vue", { ...props, isNew })
			try { assert.equal(Boolean(button(page.root, "Print")), expected) } finally { page.close() }
		})
	}
})

const options = { formats: ["MGK PO", "Standard"], default_format: "MGK PO", letter_heads: ["Head A", "Head B"], default_letter_head: "Head B" }

test("print dialog defaults to the doctype's format and default letter head, then opens printview", async () => {
	await withBrowser({ can_print: [order.doctype] }, async ({ opened, requests }) => {
		const closed = []
		const page = await mountComponent("../../src/document/print/PrintDialog.vue", { doc: order, onClose: () => closed.push(true) })
		try {
			await settle()
			assert.match(requests[0][0], /mgk_yrp\.web\.print\.get_print_options\?doctype=MGK\+Purchase\+Order&name=PO%2F26\+%23\+1/)
			const [format, letterHead] = nodes(page.root, (node) => node.tag === "select")
			assert.equal(format.props.value, "MGK PO")
			assert.equal(letterHead.props.value, "Head B")
			await button(page.root, "Print").props.onClick()
			const url = new URL(opened[0][0], "https://site")
			assert.equal(url.pathname, "/printview")
			assert.equal(url.searchParams.get("format"), "MGK PO")
			assert.equal(url.searchParams.get("letterhead"), "Head B")
			assert.equal(url.searchParams.get("no_letterhead"), "0")
			assert.equal(url.searchParams.get("trigger_print"), "1")
			assert.deepEqual(closed, [true])
		} finally { page.close() }
	}, async () => ({ ok: true, status: 200, json: async () => ({ message: options }) }))
})

test("print dialog Save as PDF without a letter head downloads with no_letterhead", async () => {
	const pdf = { ok: true, status: 200, headers: { get: () => "" }, blob: async () => new Blob(["%PDF"]) }
	await withBrowser({ can_print: [order.doctype] }, async ({ requests, links }) => {
		const page = await mountComponent("../../src/document/print/PrintDialog.vue", { doc: order, onClose: () => {} })
		try {
			await settle()
			const letterHead = nodes(page.root, (node) => node.tag === "select")[1]
			letterHead.props.onChange({ target: { value: "" } })
			await settle()
			await button(page.root, "Save as PDF").props.onClick()
			const [url, request] = requests.at(-1)
			assert.equal(url, "/api/method/frappe.utils.print_format.download_pdf")
			assert.deepEqual(JSON.parse(request.body), { doctype: order.doctype, name: order.name, format: "Standard", no_letterhead: 1 })
			assert.equal(links[0].clicked, true)
		} finally { page.close() }
	}, async (url) => url.includes("download_pdf") ? pdf : { ok: true, status: 200, json: async () => ({ message: { ...options, default_format: "Standard", default_letter_head: "" } }) })
})
