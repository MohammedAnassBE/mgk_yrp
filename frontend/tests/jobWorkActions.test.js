import test from "node:test"
import assert from "node:assert/strict"
import { createRenderer, nextTick, reactive } from "vue"
import { createRouter, createMemoryHistory } from "vue-router"
import { actions as challanActions } from "../src/documents/delivery-challan/actions.js"
import { actions as receiptActions } from "../src/documents/goods-received-note/actions.js"
import challan from "../src/books/delivery-challan/config.js"
import receipt from "../src/books/goods-received-note/config.js"
import { createDcFromSelection, dispatchSelection, jobWorkMethods, saveProcessPlan } from "../src/documents/shared/jobWork.js"
import { openMappedDraft, readMappedDraft } from "../src/document/mappedDraft.js"
import { runAction } from "../src/document/actionRunner.js"
import { editorMode } from "../src/item-editor/editorModes.js"
import { clearReadCaches } from "../src/api/client.js"
import { useListView } from "../src/list/useListView.js"
import { realtime } from "../src/realtime/socket.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, settle, textContent } from "./helpers/component.js"

const source = { doctype: challan.doctype, name: "DC-1", docstatus: 1, close_status: "Open" }
const button = (root, label) => nodes(root, (node) => node.tag === "button" && textContent(node) === label)[0]
const input = (root, label) => nodes(root, (node) => node.tag === "input" && node.props["aria-label"] === label)[0]
const planItems = [{ attributes: [], primary_attribute: "", primary_attribute_values: [], items: [
	{ name: "Fabric", row_index: "0", attributes: {}, values: { default: { qty: 4, rate: 0 } } },
] }]

function mockNetwork(respond = () => undefined) {
	const original = globalThis.fetch
	const requests = []
	globalThis.fetch = async (url, options) => {
		const parsed = new URL(url, "http://site")
		const method = parsed.pathname.split("/").at(-1)
		const args = options.method === "POST" ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams)
		requests.push({ method, args })
		let message = await respond(method, args)
		if (message === undefined) {
			if (method === jobWorkMethods.getPlan) message = planItems
			else if (method === "frappe.desk.form.load.getdoctype") return { ok: true, status: 200, json: async () => ({ docs: [{ name: args.doctype }] }) }
			else if (method === "mgk_yrp.stock.item_editor.get_editor_context") message = { defaults: {}, po_entries: [] }
			else if (method === "yrp.stock.api.get_stock_dimensions_for_ui") message = []
			else if (method === "frappe.desk.search.search_link") message = [{ value: args.doctype === "Supplier" ? "Worker" : "Dyeing" }]
			else throw new Error(`Unexpected request: ${method}`)
		}
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	return { requests, close() { globalThis.fetch = original; clearReadCaches() } }
}

test("job-work DC action visibility matches Desk and plan requires write rather than create", () => {
	const keys = (doc, can = () => true) => challanActions(doc, can).filter((action) => ["create-grn", "update-plan"].includes(action.key))
	assert.deepEqual(keys(source).map((action) => action.key), ["create-grn", "update-plan"])
	for (const flags of [{ docstatus: 0 }, { docstatus: 2 }, { is_return: 1 }, { is_internal_transfer: 1 },
		{ close_status: "Closed" }, { close_status: "Reopening" }, { close_status: undefined }]) assert.deepEqual(keys({ ...source, ...flags }), [])
	assert.deepEqual(keys(source, () => false), [])
	assert.deepEqual(keys(source, (doctype, permission) => doctype === "MGK Process Planning" && permission === "create"), [])
	assert.deepEqual(keys(source, (doctype, permission) => doctype === "MGK Process Planning" && permission === "write").map((action) => action.key), ["update-plan"])
	assert.deepEqual(keys(source, (doctype, permission) => doctype === receipt.doctype && permission === "create").map((action) => action.key), ["create-grn"])
})

test("Create DC matches submitted non-internal Desk visibility and needs create and submit", () => {
	const doc = { doctype: receipt.doctype, docstatus: 1 }
	const keys = (record, can = () => true) => receiptActions(record, can).filter((action) => action.key === "create-dc")
	for (const flags of [{ docstatus: 0 }, { docstatus: 2 }, { is_internal_transfer: 1 }]) assert.deepEqual(keys({ ...doc, ...flags }), [])
	assert.deepEqual(keys(doc, (doctype, permission) => doctype === challan.doctype && permission === "write"), [])
	assert.deepEqual(keys(doc, (doctype, permission) => doctype === challan.doctype && permission === "create"), [])
	assert.equal(keys(doc, (doctype, permission) => doctype === challan.doctype && ["create", "submit"].includes(permission)).length, 1)
})

test("Create GRN maps source_name to a job-work draft with plan/conversion prefill intact", async () => {
	const action = challanActions(source, () => true).find((action) => action.key === "create-grn")
	const store = new Map(), storage = { setItem: (key, value) => store.set(key, value), getItem: (key) => store.get(key) }
	const draft = { doctype: receipt.doctype, against_purchase_order: 0, process_name: "Dyeing", __onload: { item_details: planItems } }
	await openMappedDraft(action, source.name, { storage, call: async (method, args) => {
		assert.equal(method, "frappe.model.mapper.make_mapped_doc")
		assert.deepEqual(args, { method: jobWorkMethods.createGrn, source_name: source.name })
		return draft
	}, navigate: async (route) => {
		assert.equal(route.path, "/goods-received-note/new")
		const staged = readMappedDraft(route.query.draft, receipt.doctype, storage)
		assert.deepEqual(staged.__onload.item_details, planItems)
		assert.equal(editorMode(staged), "grn_job")
	} })
})

test("warehouse move uses the single document or all bulk warehouses", () => {
	for (const target of [{ doc: { name: "GRN-1", warehouse: "Main" }, rows: [{ warehouse: "Other" }] },
		{ names: ["GRN-1", "GRN-2"], rows: [{ warehouse: "Main" }, { warehouse: "Main" }] }]) {
		assert.equal(dispatchSelection(target).is_forced, false)
		assert.equal(dispatchSelection(target).move_to_head_office, false)
	}
	const selection = dispatchSelection({ names: ["GRN-1", "GRN-2"], rows: [{ warehouse: "Main" }, { warehouse: "Other" }] })
	assert.equal(selection.is_forced, true)
	assert.equal(selection.move_to_head_office, true)
})

test("bulk Create GRN opens the mapped receipt as an unsaved draft like Desk", async () => {
	const store = new Map()
	globalThis.window = { ...(globalThis.window || {}), sessionStorage: { setItem: (key, value) => store.set(key, value), getItem: (key) => store.get(key) ?? null } }
	const calls = [], routes = []
	await runAction(challan.bulkActions[0], { names: ["DC-1", "DC-2"], rows: [] }, {
		call: async (method, args) => { calls.push({ method, args }); return { ...source, doctype: receipt.doctype, __islocal: 1 } },
		navigate: async (route) => routes.push(route), finished: async () => {},
	})
	assert.deepEqual(calls, [{ method: jobWorkMethods.createGrn, args: { source_names: ["DC-1", "DC-2"] } }])
	assert.equal(routes[0].path, "/goods-received-note/new")
	assert.equal(JSON.parse(store.get(`mgk:draft:${routes[0].query.draft}`)).doctype, receipt.doctype)
	const message = "Selected Delivery Challans must have the same supplier and process."
	await assert.rejects(runAction(challan.bulkActions[0], { names: ["DC-1", "DC-2"] }, {
		call: async () => { throw new Error(message) }, navigate: () => assert.fail("invalid mix"),
	}), { message })
	assert.equal(receipt.bulkActions[0].key, "create-dc")
	assert.equal(typeof receipt.bulkActions[0].dialog, "function")
})

test("plan save payload is a JSON string and dispatch payload forces move and returns the DC plus plain Stock Entry text", async () => {
	const result = await saveProcessPlan("DC-1", planItems, async (method, args) => {
		assert.equal(method, jobWorkMethods.savePlan)
		assert.deepEqual(args, { delivery_challan: "DC-1", item_details: JSON.stringify(planItems) })
	})
	assert.equal(result.message, "Process plan updated.")
	const dispatch = await createDcFromSelection({ source_names: ["GRN-1", "GRN-2"], is_forced: true },
		{ process_name: "Dyeing", supplier: "Worker", move_to_head_office: false }, async (method, args) => {
			assert.equal(method, jobWorkMethods.createDc)
			assert.deepEqual(args, { source_names: ["GRN-1", "GRN-2"], process_name: "Dyeing", supplier: "Worker", move_to_head_office: 1 })
			return { delivery_challan: "DC/2", stock_entries: ["STE-1", "STE-2"] }
		}, () => true)
	const denied = (doctype, permission) => !(doctype === "YRP Stock Entry" && permission === "submit")
	for (const [selection, move_to_head_office] of [[{ source_names: ["GRN-1"], is_forced: true }, false], [{ source_names: ["GRN-1"] }, true]]) {
		await assert.rejects(createDcFromSelection(selection, { move_to_head_office }, async () => assert.fail("must not call"), denied), /YRP Stock Entry/)
	}
	assert.deepEqual(dispatch.links, [{ label: "DC/2", to: "/delivery-challan/DC%2F2" }])
	assert.equal(dispatch.message, "Dispatch submitted (Stock Entries: STE-1, STE-2):")
	assert.equal(dispatch.message.includes("DC/2"), false)
	const direct = await createDcFromSelection({ source_names: ["GRN-1"] }, {}, async () => ({ delivery_challan: "DC/3" }))
	assert.equal(direct.message, "Dispatch submitted:")
	assert.deepEqual(direct.links, [{ label: "DC/3", to: "/delivery-challan/DC%2F3" }])
})

test("Update Plan mounts after show, disables Save until ready, and saves once without navigation", async () => {
	let releasePlan, finishSave, done
	const network = mockNetwork((method) => {
		if (method === jobWorkMethods.getPlan) return new Promise((resolve) => { releasePlan = () => resolve(planItems) })
		if (method === jobWorkMethods.savePlan) return new Promise((resolve) => { finishSave = () => resolve("PLAN-1") })
	})
	const page = await mountComponent("../../src/documents/delivery-challan/UpdatePlanDialog.vue", { doc: source, onDone: (result) => { done = result } })
	try {
		assert.equal(network.requests.length, 0)
		assert.equal(button(page.root, "Save").props.disabled, true)
		nodes(page.root, (node) => node.tag === "dialog")[0].props.onShow()
		await settle()
		assert.deepEqual(network.requests[0], { method: jobWorkMethods.getPlan, args: { delivery_challan: "DC-1" } })
		assert.equal(network.requests.some((row) => row.method.includes("get_editor_context")), false)
		releasePlan(); await settle(); await settle()
		assert.equal(button(page.root, "Save").props.disabled, false)
		const save = button(page.root, "Save").props.onClick
		const pending = save()
		await save(); await settle()
		assert.equal(button(page.root, "Save").props.disabled, true)
		const requests = network.requests.filter((row) => row.method === jobWorkMethods.savePlan)
		assert.equal(requests.length, 1)
		assert.equal(requests[0].args.delivery_challan, "DC-1")
		assert.deepEqual(JSON.parse(requests[0].args.item_details), planItems)
		finishSave(); await pending
		assert.equal(done.message, "Process plan updated.")
	} finally { releasePlan?.(); finishSave?.(); page.close(); network.close() }
})

test("Update Plan item and received-type inputs share the document editor style wrapper", async () => {
	const network = mockNetwork((method) => method === "yrp.stock.api.get_stock_dimensions_for_ui"
		? [{ fieldname: "received_type", label: "Received type", options: "YRP Received Type" }] : undefined)
	const page = await mountComponent("../../src/documents/delivery-challan/UpdatePlanDialog.vue", { doc: source })
	try {
		nodes(page.root, (node) => node.tag === "dialog")[0].props.onShow()
		await settle(); await settle()
		const wrapper = nodes(page.root, (node) => node.props.class === "book-entry")[0]
		assert.ok(wrapper)
		const fields = nodes(wrapper, (node) => node.tag === "input" && node.props.role === "combobox")
		assert.deepEqual(fields.map((node) => node.props["aria-label"]), ["Item", "Received type"])
		assert.match(textContent(wrapper), /Add item/)
	} finally { page.close(); network.close() }
})

test("Create DC dialog forces and locks move for two warehouses and leaves one warehouse editable and off", async () => {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { user: { can_create: ["YRP Stock Entry"], can_submit: ["YRP Stock Entry"] } } } }
	for (const warehouses of [["Main"], ["Main", "Main"], ["Main", "Other"]]) {
		const network = mockNetwork()
		const page = await mountComponent("../../src/documents/goods-received-note/CreateDcDialog.vue", {
			names: warehouses.map((_, index) => `GRN-${index}`), rows: warehouses.map((warehouse) => ({ warehouse })),
		})
		try {
			const checkbox = input(page.root, "Move stock to Head Office")
			const is_forced = new Set(warehouses).size > 1
			assert.equal(checkbox.props.disabled, is_forced)
			assert.equal(checkbox.props["aria-readonly"], is_forced)
			assert.equal(checkbox.props["onUpdate:modelValue"] !== undefined, true)
			assert.equal(checkbox.checked, is_forced)
			assert.equal(button(page.root, "Create DC").props.disabled, true)
		} finally { page.close(); network.close() }
	}
	globalThis.window = { frappe: { boot: { user: {} } } }
	for (const warehouses of [["Main"], ["Main", "Other"]]) {
		const page = await mountComponent("../../src/documents/goods-received-note/CreateDcDialog.vue", {
			names: warehouses.map((_, index) => `GRN-${index}`), rows: warehouses.map((warehouse) => ({ warehouse })) })
		try {
			const is_forced = warehouses.length > 1
			assert.equal(Boolean(input(page.root, "Move stock to Head Office")), is_forced)
			assert.equal(textContent(page.root).includes("permission on YRP Stock Entry"), is_forced)
		} finally { page.close() }
	}
	globalThis.window = original
})

test("GRN list always fetches warehouse even when the user hides its column", async () => {
	const originals = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	const socket = new FakeSocket(), requests = []
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => socket })
	globalThis.window = { frappe: { boot: { user: { can_read: [receipt.doctype], can_create: [] } } },
		sessionStorage: { getItem: () => null, setItem: () => {} }, scrollY: 0, scrollTo: () => {} }
	globalThis.fetch = async (url) => {
		requests.push(url)
		let payload
		if (url.includes("getdoctype")) payload = { docs: [{ name: receipt.doctype, fields: [{ fieldname: "warehouse", fieldtype: "Link", options: "Warehouse" }] }] }
		else if (url.includes("get_user_listview")) payload = { message: [{ fieldname: "warehouse", enabled: 0 }] }
		else if (url.includes("get_counts")) payload = { message: [0, 0, 0, 0] }
		else payload = { data: [] }
		return { ok: true, status: 200, json: async () => payload }
	}
	clearReadCaches()
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] })
	await router.push(receipt.routePath)
	const renderer = createRenderer({ createComment: () => ({}), insert: () => {}, remove: () => {}, parentNode: () => null, nextSibling: () => null })
	let model
	const app = renderer.createApp({ setup() {
		model = useListView({ ...receipt, layout: "split", baseFilters: [], defaultOrderBy: "modified desc", statusLabel: "Status" })
		return () => null
	} })
	app.use(router).mount({})
	try {
		await nextTick(); await settle(); await settle()
		assert.equal(model.columns.value.some((column) => column.fieldname === "warehouse"), false)
		const url = requests.find((url) => url.startsWith("/api/resource/"))
		assert.ok(JSON.parse(new URL(url, "http://site").searchParams.get("fields")).includes("warehouse"))
	} finally {
		app.unmount(); Object.assign(realtime, originals.realtime)
		globalThis.window = originals.window; globalThis.fetch = originals.fetch; clearReadCaches()
	}
})

test("bulk runner shows invalid supplier/process errors verbatim in its banner", async () => {
	const originalWindow = globalThis.window
	globalThis.window = { frappe: { boot: { user: { can_create: [receipt.doctype] } } } }
	const message = "Selected Delivery Challans must have the same supplier and process."
	const network = mockNetwork((method) => { assert.equal(method, jobWorkMethods.createGrn); throw new Error(message) })
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] })
	await router.push(challan.routePath)
	const page = await mountComponent("../../src/list/SelectionSummary.vue", { rows: [{ name: "DC-1" }, { name: "DC-2" }],
		actions: challan.bulkActions, refresh: () => assert.fail("failed actions must not refresh") }, [router])
	try {
		await button(page.root, "Create GRN").props.onClick()
		await settle()
		assert.equal(nodes(page.root, (node) => node.props.class === "server-error")[0].text, message)
	} finally { page.close(); network.close(); globalThis.window = originalWindow }
})

test("Create DC selects filtered links, saves once and preserves server errors for retry", async () => {
	let finishSave, done, attempts = 0
	const message = "Selected Goods Received Notes have no remaining quantity to send."
	const network = mockNetwork((method) => {
		if (method === jobWorkMethods.createDc) {
			if (++attempts === 1) throw new Error(message)
			return new Promise((resolve) => { finishSave = () => resolve({ delivery_challan: "DC-2", stock_entries: ["STE-1"] }) })
		}
	})
	const page = await mountComponent("../../src/documents/goods-received-note/CreateDcDialog.vue", {
		doc: { doctype: receipt.doctype, name: "GRN-1", warehouse: "Main" }, onDone: (result) => { done = result },
	})
	try {
		for (const label of ["Process", "Supplier"]) {
			input(page.root, label).props.onFocus()
			await settle()
			nodes(page.root, (node) => node.tag === "li")[0].props.onMousedown({ preventDefault() {} })
			await settle()
		}
		const searches = network.requests.filter((row) => row.method === "frappe.desk.search.search_link")
		assert.equal(searches[0].args.doctype, "YRP Process")
		assert.deepEqual(JSON.parse(searches[1].args.filters), { disabled: 0, is_company_location: 0 })
		assert.equal(button(page.root, "Create DC").props.disabled, false)
		const submit = nodes(page.root, (node) => node.tag === "form")[0].props.onSubmit
		await submit({ preventDefault() {} }); await settle()
		assert.ok(textContent(page.root).includes(message))
		assert.equal(done, undefined)
		const pending = submit({ preventDefault() {} })
		await submit({ preventDefault() {} }); await settle()
		assert.equal(attempts, 2)
		assert.equal(button(page.root, "Create DC").props.disabled, true)
		assert.deepEqual(network.requests.filter((row) => row.method === jobWorkMethods.createDc)[1].args, {
			source_names: ["GRN-1"], process_name: "Dyeing", supplier: "Worker", move_to_head_office: 0,
		})
		finishSave(); await pending
		assert.equal(done.links[0].to, "/delivery-challan/DC-2")
		assert.ok(done.message.includes("STE-1"))
	} finally { finishSave?.(); page.close(); network.close() }
})

test("connected records re-read after a cancel replaces the document", async () => {
	let reads = 0
	const network = mockNetwork((method) => {
		assert.equal(method, "mgk_yrp.web.list_counts.get_counts")
		return [reads++ === 0 ? 1 : 0]
	})
	const props = reactive({ record: { name: "DC-1", docstatus: 1 }, connections: [
		{ doctype: "YRP Stock Entry", label: "Stock Entries", filters: [["mgk_delivery_challan", "=", "DC-1"]], to: "/stock" },
	] })
	const page = await mountComponent("../../src/document/ConnectedRecords.vue", props)
	try {
		assert.equal(reads, 1)
		assert.ok(textContent(page.root).includes("1"))
		props.record = { name: "DC-1", docstatus: 2 }
		await settle()
		assert.equal(reads, 2)
		assert.ok(textContent(page.root).includes("0"))
	} finally { page.close(); network.close() }
})

test("Close DC dialog previews via the server, closes once, and keeps server errors inside the dialog", async () => {
	const preview = { posting_date: "2026-10-31", supplier: "Worker", warehouse: "Worker WH", total_dc_value: 100, total_output_qty: 10,
		output_stock_uom: "Nos", value_per_unit: 10, loss_value: 0, docstatus: 0,
		items: [{ name: "i1", item: "Fabric", stock_uom: "Kg", remaining_stock_qty: 4, own_value: 100 }],
		outputs: [{ name: "o1", item: "Shirt", input_item: "Fabric", goods_received_note: "GRN-1", stock_qty: 10, allocated_value: 100 }] }
	let finishClose, done, fail = true
	const network = mockNetwork((method) => {
		if (method === jobWorkMethods.previewClose) return preview
		if (method === jobWorkMethods.closeDc) {
			if (fail) { fail = false; throw new Error("Draft GRN GRN-2 links this Delivery Challan") }
			return new Promise((resolve) => { finishClose = () => resolve("DCC/1") })
		}
	})
	const page = await mountComponent("../../src/documents/delivery-challan/CloseDcDialog.vue", { doc: source, onDone: (result) => { done = result } })
	try {
		assert.equal(button(page.root, "Close DC").props.disabled, true)
		nodes(page.root, (node) => node.tag === "dialog")[0].props.onShow()
		await settle(); await settle()
		assert.deepEqual(network.requests[0], { method: jobWorkMethods.previewClose, args: { source_name: "DC-1" } })
		const text = textContent(page.root)
		for (const expected of ["31-10-2026", "Inputs consumed", "Linked GRN outputs", "GRN-1", "Shirt", "Fabric", "Allocated value"]) assert.match(text, new RegExp(expected))
		assert.doesNotMatch(text, /2026-10-31/)
		const form = nodes(page.root, (node) => node.tag === "form")[0]
		await form.props.onSubmit({ preventDefault() {} }); await settle()
		assert.match(textContent(page.root), /Draft GRN GRN-2/)
		assert.equal(done, undefined)
		const pending = form.props.onSubmit({ preventDefault() {} })
		await form.props.onSubmit({ preventDefault() {} }); await settle()
		assert.equal(button(page.root, "Close DC").props.disabled, true)
		assert.equal(network.requests.filter((row) => row.method === jobWorkMethods.closeDc).length, 2)
		finishClose(); await pending; await settle()
		assert.deepEqual(done, { message: "Delivery Challan DC-1 closed:", links: [{ label: "DCC/1", to: "/delivery-challan-close/DCC%2F1" }] })
	} finally { finishClose?.(); page.close(); network.close() }
})
