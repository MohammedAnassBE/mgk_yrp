import test from "node:test"
import assert from "node:assert/strict"
import { createRenderer, nextTick } from "vue"
import { createRouter, createMemoryHistory } from "vue-router"
import { useMasterForm } from "../src/masters/useMasterForm.js"
import { masters, getMaster } from "../src/masters/mastersConfig.js"
import { realtime } from "../src/realtime/socket.js"
import { clearReadCaches } from "../src/api/client.js"
import { stageNewDefaults } from "../src/list/listState.js"
import { FakeSocket } from "./helpers/fakeSocket.js"

const renderer = createRenderer({ createComment: () => ({}), createText: () => ({}), insert() {}, remove() {}, setText() {}, parentNode: () => null, nextSibling: () => null })
async function settle() { await nextTick(); await new Promise(setImmediate); await nextTick() }

async function openMaster(master, { isNew = false, manager = true, defaults, returnTo, blocked = false, boot = {}, metadataFields, writeGate } = {}) {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	const store = new Map()
	const socket = new FakeSocket()
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => socket })
	const user = { name: "tester", roles: manager ? ["System Manager"] : ["Stock User"],
		...Object.fromEntries(["read", "create", "write", "delete"].map((key) => [`can_${key}`, [master.doctype]])) }
	const listeners = {}
	globalThis.window = { frappe: { boot: { ...boot, user: { ...user, ...boot.user } } }, addEventListener: (key, fn) => { listeners[key] = fn }, removeEventListener: (key) => { delete listeners[key] },
		sessionStorage: { getItem: (key) => store.get(key), setItem: (key, value) => store.set(key, value) } }
	const requests = []
	const primary = master.fields?.find((name) => !["enabled", "disabled"].includes(name)) || "title"
	const fields = metadataFields || [...new Set([primary, ...(master.doctype === "User" ? ["enabled"] : ["disabled"])])].map((fieldname) => ({ fieldname, label: fieldname, fieldtype: ["disabled", "enabled"].includes(fieldname) ? "Check" : "Data", read_only: master.doctype === "User" && fieldname === "enabled" ? 1 : 0, reqd: fieldname === primary ? 1 : 0 }))
	let record = { doctype: master.doctype, name: "Record / 1", docstatus: 0, modified: "first", [primary]: "Initial", disabled: 0, enabled: 1, roles: [{ role: "Stock User" }] }
	let conflict = false
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options })
		let response
		if (url.includes("getdoctype")) response = { docs: [{ name: master.doctype, fields, permissions: [{ role: manager ? "System Manager" : "Stock User", read: 1, write: 1 }] }] }
		else if (url.includes("getdoc")) response = { docs: [record] }
		else if (/frappe.client.(insert|save)$/.test(url)) {
			if (conflict) return { ok: false, status: 417, json: async () => ({ exc_type: "TimestampMismatchError" }) }
			record = { ...JSON.parse(options.body).doc, name: "Record / 1", modified: "saved", __islocal: 0 }
			if (writeGate) await writeGate
			response = { message: record }
		} else response = { message: null }
		return { ok: true, status: 200, json: async () => structuredClone(response) }
	}
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `${master.route}/new`, component: { render: () => null } }, { path: `${master.route}/:name`, component: { render: () => null } }, { path: "/:pathMatch(.*)*", component: { render: () => null } }] })
	const query = { ...(returnTo ? { returnTo } : {}) }
	if (defaults) query.defaults = stageNewDefaults(master.doctype, defaults, returnTo)
	await router.push({ path: isNew ? `${master.route}/new` : `${master.route}/${encodeURIComponent(record.name)}`, query })
	let model
	const app = renderer.createApp({ setup() { model = useMasterForm(master, { blocked: () => blocked }); return () => null } })
	app.use(router).mount({})
	await settle()
	return { model, router, requests, socket, primary, conflict: () => { conflict = true }, keydown: (event) => listeners.keydown(event),
		setRecord: (value) => { record = { ...record, ...value } },
		close: () => { app.unmount(); Object.assign(realtime, original.realtime); globalThis.window = original.window; globalThis.fetch = original.fetch; clearReadCaches() } }
}

test("a delayed master insert cannot replace a route the user has navigated to", async () => {
	let finish
	const writeGate = new Promise((resolve) => { finish = resolve })
	const page = await openMaster(getMaster("warehouses"), { isNew: true, writeGate, returnTo: "/manage/suppliers/OLD" })
	try {
		page.model.change(page.primary, "Created")
		const record = page.model.doc.value
		const pending = page.model.save()
		await settle()
		await page.router.push("/manage/items/OTHER")
		finish(); await pending
		assert.equal(page.router.currentRoute.value.path, "/manage/items/OTHER")
		assert.equal(page.model.doc.value, record)
		assert.equal(page.model.doc.value.name, undefined)
	} finally { finish(); page.close() }
})

test("every Manage master uses client insert, full document save, optional disable, and delete with its own route", async () => {
	for (const master of masters) {
		const page = await openMaster(master, { isNew: true })
		try {
			assert.equal(page.model.editing.value, true, master.doctype)
			await page.model.save()
			assert.match(page.model.error.value, /Missing required/)
			assert.equal(page.requests.some((request) => request.url.endsWith("frappe.client.insert")), false)
			page.model.change(page.primary, "Created")
			await page.model.save()
			assert.ok(page.requests.some((request) => request.url.endsWith("frappe.client.insert")), master.doctype)
			assert.equal(page.router.currentRoute.value.path, `${master.route}/Record%20%2F%201`)
			assert.equal(page.model.dirty.value, false)
			page.model.change(page.primary, "Edited")
			if (page.model.toggle.value) page.model.change(page.model.toggle.value.fieldname, 1)
			await page.model.save()
			const saved = page.requests.findLast((request) => request.url.endsWith("frappe.client.save"))
			assert.equal(JSON.parse(saved.options.body).doc[page.primary], "Edited")
			assert.equal(JSON.parse(saved.options.body).doc.modified, "saved")
			await page.model.remove()
			assert.equal(page.router.currentRoute.value.path, master.route)
			assert.deepEqual(JSON.parse(page.requests.findLast((request) => request.url.endsWith("frappe.client.delete")).options.body), { doctype: master.doctype, name: "Record / 1" })
		} finally { page.close() }
	}
})

test("User writes and deletion require System Manager even when boot grants write permission", async () => {
	const page = await openMaster(getMaster("users"), { manager: false })
	try {
		assert.equal(page.model.editing.value, false)
		assert.equal(page.model.canDelete.value, false)
		page.model.change(page.primary, "Changed")
		await page.model.save()
		await page.model.remove()
		assert.equal(page.model.doc.value[page.primary], "Initial")
		assert.equal(page.requests.some((request) => request.options.method === "POST"), false)
	} finally { page.close() }
})

test("User saves roles child rows and access loading blocks keyboard Save", async () => {
	const page = await openMaster(getMaster("users"))
	try {
		assert.equal(page.model.meta.value.fields.find((field) => field.fieldname === "enabled").read_only, 0)
		page.model.change("enabled", 0)
		page.model.change("roles", [{ doctype: "Has Role", role: "Stock Manager" }])
		let prevented = false
		page.keydown({ ctrlKey: true, key: "s", preventDefault() { prevented = true } })
		await settle()
		assert.equal(prevented, true)
		assert.deepEqual(JSON.parse(page.requests.findLast((request) => request.url.endsWith("frappe.client.save")).options.body).doc.roles, [{ doctype: "Has Role", role: "Stock Manager" }])
		assert.equal(JSON.parse(page.requests.findLast((request) => request.url.endsWith("frappe.client.save")).options.body).doc.enabled, 0)
	} finally { page.close() }
	const blocked = await openMaster(getMaster("users"), { blocked: true })
	try {
		blocked.model.change("roles", [])
		await blocked.model.save()
		assert.match(blocked.model.error.value, /access options/)
		assert.equal(blocked.requests.some((request) => request.url.endsWith("frappe.client.save")), false)
	} finally { blocked.close() }
})

test("party-prefilled links survive insertion and return to the party after saving", async () => {
	const links = [{ doctype: "Dynamic Link", link_doctype: "MGK Agent", link_name: "AG-1" }]
	const page = await openMaster(getMaster("addresses"), { isNew: true, defaults: { links }, returnTo: "/manage/agents/AG-1" })
	try {
		page.model.change(page.primary, "Office")
		await page.model.save()
		assert.deepEqual(JSON.parse(page.requests.findLast((request) => request.url.endsWith("frappe.client.insert")).options.body).doc.links, links)
		assert.equal(page.router.currentRoute.value.path, "/manage/agents/AG-1")
	} finally { page.close() }
})

test("Warehouse new form saves with the boot Company default and staged choices take precedence", async () => {
	for (const staged of [null, "Chosen Company"]) {
		const page = await openMaster(getMaster("warehouses"), { isNew: true,
			boot: { defaults: { company: "Essdee India" } }, defaults: staged ? { company: staged } : undefined,
			metadataFields: [{ fieldname: "warehouse_name", fieldtype: "Data", reqd: 1, label: "Warehouse name" },
				{ fieldname: "company", fieldtype: "Link", options: "Company", reqd: 1, label: "Company" }],
		})
		try {
			assert.equal(page.model.doc.value.company, staged || "Essdee India")
			page.model.change("warehouse_name", "New Store")
			await page.model.save()
			assert.equal(page.model.error.value, "")
			const payload = JSON.parse(page.requests.findLast((request) => request.url.endsWith("frappe.client.insert")).options.body).doc
			assert.equal(payload.company, staged || "Essdee India")
		} finally { page.close() }
	}
})

test("master conflicts preserve edits and live dirty reloads produce the stale banner", async () => {
	const page = await openMaster(getMaster("agents"))
	try {
		page.model.change(page.primary, "Local edit")
		page.setRecord({ [page.primary]: "Remote edit", modified: "remote" })
		await page.model.reload(true)
		assert.equal(page.model.stale.value, true)
		assert.equal(page.model.doc.value[page.primary], "Local edit")
		page.conflict()
		await page.model.save()
		assert.equal(page.model.stale.value, true)
		assert.equal(page.model.dirty.value, true)
		await page.model.reload()
		assert.equal(page.model.doc.value[page.primary], "Remote edit")
		assert.equal(page.model.stale.value, false)
	} finally { page.close() }
})
