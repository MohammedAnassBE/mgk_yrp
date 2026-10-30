import { afterEach, beforeEach, test } from "node:test"
import assert from "node:assert/strict"
import { extractServerMessage, isSessionExpired, serverMessages } from "../src/api/errors.js"
import { callDocMethod, callMethod, callRead, clearReadCaches, getCounts, getDocument, getMeta, request } from "../src/api/client.js"
import { getRows, searchLinks } from "../src/list/listApi.js"

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const originalDocument = globalThis.document
let redirects
let calls

function response(payload, status = 200) {
	return { status, ok: status >= 200 && status < 300, json: async () => payload }
}

test("document loads retain onload and controller calls use run_doc_method with full docs and args", async () => {
	const doc = { doctype: "MGK Purchase Invoice", name: "PI-1", __onload: { valuation_pending: true } }
	globalThis.fetch = async (...args) => { calls.push(args); return response({ docs: [doc], message: { total: 10 } }) }
	assert.deepEqual(await getDocument(doc.doctype, doc.name), doc)
	assert.match(calls[0][0], /frappe.desk.form.load.getdoc/)
	assert.deepEqual(await callDocMethod(doc, "preview_taxes", { extra: 1 }), { message: { total: 10 }, doc, messages: [] })
	assert.equal(calls[1][0], "/api/method/run_doc_method")
	const body = JSON.parse(calls[1][1].body)
	assert.deepEqual(JSON.parse(body.docs), doc)
	assert.equal(body.method, "preview_taxes")
	assert.deepEqual(JSON.parse(body.args), { extra: 1 })
})

test("successful controller preview and save surface server warning messages without throwing", async () => {
	const warning = "No GST charged for these items because they have no MGK GST Tax Slab: Yarn"
	const doc = { doctype: "MGK Purchase Invoice", items: [] }
	globalThis.fetch = async () => response({ docs: [doc], message: doc,
		_server_messages: JSON.stringify([JSON.stringify({ message: warning, indicator: "orange" })]) })
	assert.deepEqual((await callDocMethod(doc, "preview_taxes")).messages, [warning])
	let displayed
	await callMethod("frappe.client.save", { doc }, (messages) => { displayed = messages })
	assert.deepEqual(displayed, [warning])
})

beforeEach(() => {
	clearReadCaches()
	redirects = []
	calls = []
	globalThis.window = {
		csrf_token: "csrf-test",
		frappe: { boot: { user: { name: "stock@example.test" } } },
		location: {
			host: "mgk_new.site:8001", pathname: "/web/delivery-challan", search: "?tab=all", hash: "",
			assign: (url) => redirects.push(url),
		},
	}
	globalThis.document = { cookie: "user_id=stock@example.test" }
	globalThis.fetch = async (...args) => { calls.push(args); return response({ message: [] }) }
})

afterEach(() => {
	clearReadCaches()
	globalThis.fetch = originalFetch
	globalThis.window = originalWindow
	globalThis.document = originalDocument
})

test("parses nested Frappe server messages into readable text", () => {
	const payload = { _server_messages: JSON.stringify([
		JSON.stringify({ message: "<b>Supplier</b> is required<br>Choose a supplier &amp; retry." }),
		JSON.stringify({ message: "Bill already linked" }),
	]) }
	assert.equal(extractServerMessage(payload), "Supplier is required\nChoose a supplier & retry.\nBill already linked")
	assert.deepEqual(serverMessages({ _server_messages: '["plain message"]' }), ["plain message"])
	assert.equal(extractServerMessage({ _server_messages: "Plain server error" }), "Plain server error")
	assert.equal(extractServerMessage({ message: "Validation failed" }), "Validation failed")
	assert.equal(extractServerMessage({}, "Try again"), "Try again")
})

test("deduplicates concurrent GETs and returns independent results", async () => {
	let complete
	globalThis.fetch = (...args) => {
		calls.push(args)
		return new Promise((resolve) => { complete = () => resolve(response({ message: [{ name: "DC-1" }] })) })
	}
	const first = callRead("example.read", { filters: { b: 2, a: 1 }, doctype: "MGK Delivery Challan" })
	const second = callRead("example.read", { doctype: "MGK Delivery Challan", filters: { a: 1, b: 2 } })
	assert.equal(calls.length, 1)
	complete()
	const [left, right] = await Promise.all([first, second])
	left[0].name = "changed"
	assert.equal(right[0].name, "DC-1")
})

test("GET deduplication ends when the request settles", async () => {
	await callRead("example.read")
	await callRead("example.read")
	assert.equal(calls.length, 2)
})

test("failed GETs are evicted and can be retried", async () => {
	globalThis.fetch = async (...args) => {
		calls.push(args)
		if (calls.length === 1) throw new Error("Network unavailable")
		return response({ message: 2 })
	}
	await assert.rejects(callRead("example.read"), /Network unavailable/)
	assert.equal(await callRead("example.read"), 2)
	assert.equal(calls.length, 2)
})

test("sends the CSRF header and includes credentials", async () => {
	await callMethod("example.write", { value: 1 })
	const [url, options] = calls[0]
	assert.equal(url, "/api/method/example.write")
	assert.equal(options.credentials, "include")
	assert.equal(options.headers["X-Frappe-CSRF-Token"], "csrf-test")
	assert.equal(options.method, "POST")
	assert.deepEqual(JSON.parse(options.body), { value: 1 })
})

test("does not deduplicate writes", async () => {
	await Promise.all([callMethod("example.write"), callMethod("example.write")])
	assert.equal(calls.length, 2)
})

test("home count request sends a single ordered batch", async () => {
	globalThis.fetch = async (...args) => { calls.push(args); return response({ message: [3, 8] }) }
	const sets = [{ doctype: "MGK Delivery Challan", filters: [] }, { doctype: "MGK Goods Received Note", filters: [] }]
	assert.deepEqual(await getCounts(sets), [3, 8])
	assert.equal(calls.length, 1)
	assert.deepEqual(JSON.parse(new URL(calls[0][0], "http://mgk_new.site").searchParams.get("doctype_filter_sets")), sets)
})

test("401 redirects to login even for a non-JSON response", async () => {
	globalThis.fetch = async () => ({ ...response(null, 401), json: async () => { throw new SyntaxError("HTML") } })
	await assert.rejects(callRead("example.read"), /session has expired/)
	assert.equal(redirects[0], "/login?redirect-to=%2Fweb%2Fdelivery-challan%3Ftab%3Dall")
})

test("expired session redirects but ordinary permission denial does not", async () => {
	assert.equal(isSessionExpired(403, { exc_type: "SessionExpired" }), true)
	assert.equal(isSessionExpired(403, { exc_type: "PermissionError", message: "Login to access this page" }), true)
	globalThis.fetch = async () => response({ exc_type: "PermissionError", message: "No access" }, 403)
	await assert.rejects(callRead("example.read"), /No access/)
	assert.deepEqual(redirects, [])
	globalThis.fetch = async () => response({ exc_type: "AuthenticationError" }, 403)
	await assert.rejects(callRead("example.read"), /session has expired/)
	assert.equal(redirects.length, 1)
})

test("surfaces server validation errors and unreadable responses", async () => {
	globalThis.fetch = async () => response({ exc_type: "ValidationError", _server_messages: '["Choose a supplier"]' }, 417)
	await assert.rejects(callMethod("example.write"), /Choose a supplier/)
	globalThis.fetch = async () => ({ ...response(null), json: async () => { throw new SyntaxError("HTML") } })
	await assert.rejects(callRead("example.read"), /unreadable response/)
})

test("metadata cache returns copies and evicts the least recently used entry at 20", async () => {
	globalThis.fetch = async (url, options) => {
		calls.push([url, options])
		return response({ docs: [{ name: new URL(url, "http://mgk_new.site").searchParams.get("doctype") }] })
	}
	for (let index = 0; index < 20; index += 1) await getMeta(`Type ${index}`)
	const cached = await getMeta("Type 0")
	cached[0].name = "changed"
	assert.equal((await getMeta("Type 0"))[0].name, "Type 0")
	assert.equal(calls.length, 20)
	await getMeta("Type 20")
	await getMeta("Type 0")
	assert.equal(calls.length, 21)
	await getMeta("Type 1")
	assert.equal(calls.length, 22)
})

test("failed metadata reads are not cached", async () => {
	globalThis.fetch = async (...args) => { calls.push(args); return response({ message: "Try again" }, 500) }
	await assert.rejects(getMeta("Item"), /Try again/)
	await assert.rejects(getMeta("Item"), /Try again/)
	assert.equal(calls.length, 2)
})

test("metadata and in-flight reads are isolated by session identity", async () => {
	await getMeta("Item")
	window.frappe.boot.user.name = "other@example.test"
	await getMeta("Item")
	document.cookie = "user_id=third@example.test"
	await getMeta("Item")
	assert.equal(calls.length, 3)
})

test("metadata is invalidated by method writes", async () => {
	await getMeta("Item")
	await getMeta("Item")
	await callMethod("example.write")
	await getMeta("Item")
	assert.equal(calls.length, 3)
})

test("handles no-content responses", async () => {
	globalThis.fetch = async () => response(null, 204)
	assert.deepEqual(await request("/api/method/logout", { method: "POST" }), {})
})

test("row GET unwraps resource data; long row queries POST with the same credentials and CSRF token", async () => {
	globalThis.fetch = async (...args) => { calls.push(args); return response(args[0].startsWith("/api/resource/") ? { data: [{ name: "PO-1" }] } : { message: [{ name: "PO-2" }] }) }
	const parameters = { fields: ["name"], filters: [], limit_start: 0, limit: 20, order_by: "modified desc, name desc" }
	assert.deepEqual(await getRows("MGK Purchase Order", parameters), [{ name: "PO-1" }])
	assert.deepEqual(await getRows("MGK Purchase Order", { ...parameters, filters: [["name", "in", Array.from({ length: 500 }, (_, index) => `PO-${index}`)]] }), [{ name: "PO-2" }])
	const [url, options] = calls[1]
	assert.equal(url, "/api/method/frappe.client.get_list")
	assert.equal(options.method, "POST")
	assert.equal(options.credentials, "include")
	assert.equal(options.headers["X-Frappe-CSRF-Token"], "csrf-test")
})

test("Link values use the permission-aware Desk link search method", async () => {
	globalThis.fetch = async (...args) => { calls.push(args); return response({ message: [{ value: "S-1", description: "Supplier One" }] }) }
	assert.deepEqual(await searchLinks("Supplier", "Sup"), [{ value: "S-1", description: "Supplier One" }])
	const url = new URL(calls[0][0], "http://site")
	assert.equal(url.pathname, "/api/method/frappe.desk.search.search_link")
	assert.equal(url.searchParams.get("doctype"), "Supplier")
	assert.equal(url.searchParams.get("txt"), "Sup")
})
