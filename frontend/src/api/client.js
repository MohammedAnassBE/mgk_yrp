import { extractServerMessage, isSessionExpired, serverMessages } from "./errors.js"

const pendingReads = new Map()
const metadata = new Map()
const METADATA_LIMIT = 20
let readGeneration = 0

function orderedArguments(value) {
	if (Array.isArray(value)) return value.map(orderedArguments)
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, orderedArguments(value[key])]))
	}
	return value
}

function sessionIdentity() {
	const browser = globalThis.window
	const cookieUser = /(?:^|;\s*)user_id=([^;]*)/.exec(globalThis.document?.cookie || "")?.[1]
	return [browser?.location?.host, browser?.frappe?.boot?.user?.name, browser?.csrf_token, cookieUser]
}

function requestKey(url) {
	return JSON.stringify([sessionIdentity(), readGeneration, url])
}

export function clearReadCaches() {
	readGeneration += 1
	pendingReads.clear()
	metadata.clear()
}

export function invalidateReads() {
	readGeneration += 1
	pendingReads.clear()
}

export function redirectToLogin() {
	clearReadCaches()
	const location = window.location
	const next = location.pathname + location.search + (location.hash || "")
	location.assign(`/login?redirect-to=${encodeURIComponent(next)}`)
}

function queryString(parameters) {
	const query = new URLSearchParams()
	for (const key of Object.keys(parameters).sort()) {
		const value = parameters[key]
		if (value === undefined || value === null) continue
		query.set(key, typeof value === "object" ? JSON.stringify(orderedArguments(value)) : String(value))
	}
	return query.size ? `?${query}` : ""
}

async function sendRequest(url, options) {
	const response = await fetch(url, {
		...options,
		credentials: "include",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Frappe-CSRF-Token": globalThis.window?.csrf_token || "",
			...options.headers,
		},
	})
	if (response.status === 401) {
		redirectToLogin()
		throw new Error("Your session has expired.")
	}
	const payload = await readPayload(response)
	if (isSessionExpired(response.status, payload)) {
		redirectToLogin()
		throw new Error("Your session has expired.")
	}
	if (!response.ok || payload.exc || payload.exc_type) {
		const error = new Error(extractServerMessage(payload))
		Object.assign(error, { status: response.status, payload })
		throw error
	}
	return payload
}

async function readPayload(response) {
	if (response.status === 204) return {}
	try {
		return await response.json()
	} catch (cause) {
		throw new Error("The server returned an unreadable response. Please reload and try again.", { cause })
	}
}

export async function request(url, options = {}) {
	const method = (options.method || "GET").toUpperCase()
	if (method !== "GET") return sendRequest(url, { ...options, method })
	const key = requestKey(url)
	let pending = pendingReads.get(key)
	if (!pending) {
		pending = sendRequest(url, { ...options, method }).finally(() => pendingReads.delete(key))
		pendingReads.set(key, pending)
	}
	return structuredClone(await pending)
}

export async function callRead(method, args = {}) {
	const payload = await request(`/api/method/${method}${queryString(args)}`)
	return payload.message
}

export async function callMethod(method, args = {}, messages = () => {}) {
	clearReadCaches()
	try {
		const payload = await request(`/api/method/${method}`, { method: "POST", body: JSON.stringify(args) })
		messages(serverMessages(payload))
		return payload.message
	} finally {
		clearReadCaches()
	}
}

export async function getMeta(doctype) {
	const key = JSON.stringify([sessionIdentity(), doctype])
	if (metadata.has(key)) {
		const cached = metadata.get(key)
		metadata.delete(key)
		metadata.set(key, cached)
		return structuredClone(cached)
	}
	const generation = readGeneration
	const payload = await request(`/api/method/frappe.desk.form.load.getdoctype${queryString({ doctype })}`)
	const docs = payload.docs || []
	if (generation === readGeneration && key === JSON.stringify([sessionIdentity(), doctype])) {
		metadata.set(key, structuredClone(docs))
		if (metadata.size > METADATA_LIMIT) metadata.delete(metadata.keys().next().value)
	}
	return docs
}

export function getCounts(doctypeFilterSets) {
	return callRead("mgk_yrp.web.list_counts.get_counts", { doctype_filter_sets: doctypeFilterSets })
}

export async function getDocument(doctype, name) {
	const payload = await request(`/api/method/frappe.desk.form.load.getdoc${queryString({ doctype, name })}`)
	if (!payload.docs?.[0]) throw new Error("The server returned no document.")
	return payload.docs[0]
}

export async function callDocMethod(doc, method, args = {}) {
	clearReadCaches()
	try {
		const result = await request("/api/method/run_doc_method", {
			method: "POST", body: JSON.stringify({ docs: JSON.stringify(doc), method, args: JSON.stringify(args) }),
		})
		return { message: result.message, doc: result.docs?.[0], messages: serverMessages(result) }
	} finally { clearReadCaches() }
}
