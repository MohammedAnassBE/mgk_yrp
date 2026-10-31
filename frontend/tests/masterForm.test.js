import test from "node:test"
import assert from "node:assert/strict"
import { createRenderer, h, nextTick, reactive } from "vue"
import { createRouter, createMemoryHistory } from "vue-router"
import { useMasterForm } from "../src/masters/useMasterForm.js"
import { masters, getMaster } from "../src/masters/mastersConfig.js"
import { realtime } from "../src/realtime/socket.js"
import { clearReadCaches } from "../src/api/client.js"
import { stageNewDefaults } from "../src/list/listState.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { loadComponent } from "./helpers/component.js"
import { fieldQuery } from "../src/document/fieldQueries.js"
import { readFile } from "node:fs/promises"

const renderer = createRenderer({ createElement: () => ({}), createComment: () => ({}), createText: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
async function settle() { await nextTick(); await new Promise(setImmediate); await nextTick() }

async function openMaster(master, { isNew = false, manager = true, defaults, returnTo, blocked = false, boot = {}, metadataFields, writeGate, initialRecord = {}, saveError } = {}) {
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
	const fields = metadataFields || [...new Set([primary, "disabled"])].map((fieldname) => ({ fieldname, label: fieldname, fieldtype: fieldname === "disabled" ? "Check" : "Data", read_only: 0, reqd: fieldname === primary ? 1 : 0 }))
	let record = { doctype: master.doctype, name: "Record / 1", docstatus: 0, modified: "first", [primary]: "Initial", disabled: 0, enabled: 1, roles: [{ role: "Stock User" }], ...initialRecord }
	let conflict = false
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options })
		let response
		if (url.includes("getdoctype")) response = { docs: [{ name: master.doctype, fields, permissions: [{ role: manager ? "System Manager" : "Stock User", read: 1, write: 1 }] }] }
		else if (url.includes("getdoc")) response = { docs: [record] }
		else if (/frappe.client.(insert|save)$/.test(url)) {
			if (saveError) return { ok: false, status: 417, json: async () => ({ exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message: saveError })]) }) }
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

test("variant URLs expose the template and block editing, saving and deleting", async () => {
	const page = await openMaster(getMaster("items"), { initialRecord: { variant_of: "Template / 1" } })
	try {
		assert.equal(page.model.variantTemplate.value, "Template / 1")
		assert.equal(page.model.editing.value, false)
		assert.equal(page.model.canDelete.value, false)
		assert.deepEqual(page.model.sections.value, [])
		page.model.change(page.primary, "Changed")
		await page.model.save()
		await page.model.remove()
		assert.equal(page.model.doc.value[page.primary], "Initial")
		assert.equal(page.requests.some((request) => request.options.method === "POST"), false)
	} finally { page.close() }
})

test("changing the template stock UOM refreshes every conversion From UOM and preserves quantities", async () => {
	const page = await openMaster(getMaster("items"), { initialRecord: { has_variants: 1, stock_uom: "Kg", mgk_process_conversions: [
		{ item: "Output", from_uom: "Kg", from_qty: 2, to_uom: "Nos", to_qty: 3 },
	] } })
	try {
		page.model.change("stock_uom", "Gram")
		assert.deepEqual(page.model.doc.value.mgk_process_conversions, [{ item: "Output", from_uom: "Gram", from_qty: 2, to_uom: "Nos", to_qty: 3 }])
	} finally { page.close() }
})

test("Supplier and conversion validation messages reach the master error verbatim", async () => {
	for (const [key, saveError] of [
		["suppliers", "A Head Office supplier must also be a Company Location."],
		["suppliers", "HQ-1 is already the Head Office. Untick Is Head Office there first."],
		["items", "Process Conversions can be set only on a template Item (Has Variants). Remove the rows first."],
		["items", "Row 1: From Qty and To Qty must be greater than zero."],
		["items", "Row 1: Output Item is required."],
		["items", "Row 1: Output Item Missing does not exist."],
		["items", "Row 2: Process Dyeing to Item Output is already in row 1."],
	]) {
		const page = await openMaster(getMaster(key), { saveError })
		try {
			page.model.change(page.primary, "Updated")
			await page.model.save()
			assert.equal(page.model.error.value, saveError)
			assert.equal(page.model.dirty.value, true)
		} finally { page.close() }
	}
})

function vnodeMatches(node, predicate) {
	if (!node || typeof node !== "object") return []
	const children = Array.isArray(node.children) ? node.children : []
	return [...(predicate(node) ? [node] : []), ...children.flatMap((child) => vnodeMatches(child, predicate))]
}

async function conversionTable() {
	const component = (await loadComponent(new URL("../src/document/fields/SimpleTable.vue", import.meta.url))).default
	const child = JSON.parse(await readFile(new URL("../../mgk_yrp/mgk_yrp/doctype/mgk_item_process_conversion/mgk_item_process_conversion.json", import.meta.url)))
	const props = reactive({ modelValue: [], field: { fieldname: "mgk_process_conversions", options: child.name }, metas: [child],
		parentDoc: { doctype: "Item", name: "Template / 1", has_variants: 1, stock_uom: "Kg" }, parentMeta: { permissions: [] }, user: { name: "Administrator" } })
	let vnode
	const app = renderer.createApp({ render() {
		vnode = h(component, { ...props, "onUpdate:modelValue": (value) => { props.modelValue = value } })
		return vnode
	} })
	app.mount({})
	await settle()
	return { props, close: () => app.unmount(),
		find: (predicate) => vnodeMatches(vnode.component.subTree, predicate),
		change(name, value, index = 0) {
			vnodeMatches(vnode.component.subTree, (node) => node.props?.field?.fieldname === name)[index].props.onChange(name, value)
		},
	}
}

test("conversion rows autofill UOMs, reset From Qty, exclude the template and retain required To Qty", async () => {
	const original = globalThis.fetch
	const requests = []
	globalThis.fetch = async (url) => {
		requests.push(url)
		return { ok: true, status: 200, json: async () => ({ message: { stock_uom: "Nos" } }) }
	}
	const page = await conversionTable()
	try {
		page.find((node) => node.type === "button").at(-1).props.onClick()
		await settle()
		assert.equal(page.props.modelValue[0].from_uom, "Kg")
		assert.equal(page.props.modelValue[0].from_qty, 1)
		const headers = page.find((node) => node.type === "th").map((node) => node.children).filter((value) => typeof value === "string")
		assert.deepEqual(headers, ["#", "Process", "Item", "From UOM", "From Qty", "To UOM", "To Qty"])
		page.change("from_qty", 5)
		await settle()
		page.change("item", "Output")
		await settle()
		assert.equal(page.props.modelValue[0].from_uom, "Kg")
		assert.equal(page.props.modelValue[0].from_qty, 1)
		assert.equal(page.props.modelValue[0].to_uom, "Nos")
		const query = new URL(requests[0], "http://site")
		assert.equal(query.pathname, "/api/method/frappe.client.get_value")
		assert.deepEqual(JSON.parse(query.searchParams.get("filters")), { name: "Output" })
		assert.equal(query.searchParams.get("fieldname"), "stock_uom")
		const picker = page.find((node) => node.props?.field?.fieldname === "item")[0]
		assert.deepEqual(fieldQuery(picker.props.field, picker.props.doc), { filters: { variant_of: ["is", "not set"], disabled: 0 } })
		assert.equal(page.find((node) => ["from_uom", "to_uom"].includes(node.props?.field?.fieldname)).length, 0)
		page.change("item", "")
		await settle()
		assert.equal(page.props.modelValue[0].to_uom, null)
		assert.equal(requests.length, 1)
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("conversion output lookups drop stale responses and preserve edits made during a lookup", async () => {
	const original = globalThis.fetch
	const responses = new Map()
	globalThis.fetch = (url) => new Promise((resolve) => {
		const item = JSON.parse(new URL(url, "http://site").searchParams.get("filters")).name
		responses.set(item, (stock_uom) => resolve({ ok: true, status: 200, json: async () => ({ message: { stock_uom } }) }))
	})
	const page = await conversionTable()
	try {
		page.find((node) => node.type === "button").at(-1).props.onClick()
		await settle()
		page.change("item", "Old")
		await settle()
		page.change("item", "Current")
		await settle()
		page.change("to_qty", 7)
		await settle()
		responses.get("Current")("Nos")
		await settle()
		responses.get("Old")("Meter")
		await settle()
		assert.equal(page.props.modelValue[0].to_uom, "Nos")
		assert.equal(page.props.modelValue[0].to_qty, 7)
		page.change("item", "Removed")
		await settle()
		page.find((node) => node.type === "button")[0].props.onClick()
		await settle()
		responses.get("Removed")("Meter")
		await settle()
		assert.deepEqual(page.props.modelValue, [])
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
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
