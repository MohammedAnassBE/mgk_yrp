import test from "node:test"
import assert from "node:assert/strict"
import { reactive } from "vue"
import { previewActions } from "../src/list/previewActions.js"
import { actions as orderActions } from "../src/documents/purchase-order/actions.js"
import { actions as challanActions } from "../src/documents/delivery-challan/actions.js"
import { hasPermissions } from "../src/permissions/usePermissions.js"
import { actionToastText, bindToast, documentToast } from "../src/shared/notify.js"
import { button, mountSplit, runMenuAction } from "./helpers/splitList.js"
import { mountComponent, nodes, settle, textContent } from "./helpers/component.js"

const order = "MGK Purchase Order"
const only = (granted) => (doctype, permission) => (granted[doctype] || []).includes(permission)
const labels = (root) => nodes(root, (node) => node.tag === "button").map(textContent)

async function mountActions(permissions, doc) {
	const listeners = {}
	globalThis.window = { frappe: { boot: { user: Object.fromEntries(permissions.map((key) => [`can_${key}`, [order]])) } },
		addEventListener: (name, handler) => { listeners[name] = handler }, removeEventListener: (name) => { delete listeners[name] } }
	const emitted = []
	const props = reactive({ doc: { doctype: order, name: "PO-1", ...doc }, meta: { is_submittable: 1 }, editing: true,
		isNew: false, dirty: false, busy: false, onAction: (action) => emitted.push(action) })
	const page = await mountComponent("../../src/document/DocumentActions.vue", props)
	return { ...page, props, emitted, press: () => listeners.keydown({ ctrlKey: true, key: "s", preventDefault() {} }) }
}

test("form hides Submit, Cancel, Amend, Delete and Save without their permissions and Ctrl+S never submits", async () => {
	const original = globalThis.window
	const page = await mountActions(["read", "write"], { docstatus: 0 })
	try {
		assert.deepEqual(labels(page.root), [])
		page.press(); await settle()
		assert.equal(textContent(page.root).includes("Confirm submit"), false)
		assert.deepEqual(page.emitted, [])
		for (const docstatus of [1, 2]) { page.props.doc.docstatus = docstatus; await settle(); assert.deepEqual(labels(page.root), []) }
		page.props.doc.docstatus = 0; page.props.isNew = true; page.props.dirty = true; await settle()
		assert.deepEqual(labels(page.root), [])
	} finally { page.close() }
	const amend = await mountActions(["amend", "delete"], { docstatus: 2 })
	try { assert.deepEqual(labels(amend.root), ["Delete"]) } finally { amend.close(); globalThis.window = original }
})

test("preview menu and job-work actions require the target doctype permissions", () => {
	const draft = { doctype: order, name: "PO-1", docstatus: 0 }
	assert.deepEqual(previewActions(draft, { is_submittable: 1 }, only({ [order]: ["create", "write"] })), [])
	assert.deepEqual(previewActions({ ...draft, docstatus: 1 }, { is_submittable: 1 }, only({ [order]: ["submit"] })), [])
	const pending = { ...draft, docstatus: 1, items: [{ pending_qty: 2 }] }
	assert.deepEqual(orderActions(pending, only({ "MGK Goods Received Note": ["create"] })).map((action) => action.key), ["create-grn"])
	assert.deepEqual(orderActions(pending, only({ "MGK Goods Received Note": ["create", "submit"] })).map((action) => action.key), ["create-grn", "mark-as-received"])
	assert.deepEqual(orderActions(pending, () => false), [])
	const challan = { doctype: "MGK Delivery Challan", docstatus: 1, close_status: "Open", items: [] }
	assert.equal(challanActions(challan, only({ "MGK Delivery Challan Close": ["create"] })).some((action) => action.key === "close"), false)
	assert.equal(challanActions(challan, only({ "MGK Delivery Challan Close": ["create", "submit"] })).some((action) => action.key === "close"), true)
	assert.equal(hasPermissions("X", ["create", "submit"], only({ X: ["create"] })), false)
})

test("+ New on book cards and bulk actions hide without create permission", async () => {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { user: { can_read: [order] } } } }
	const book = { doctype: order, label: "Purchase Orders", routePath: "/purchase-order", code: "PO" }
	const card = await mountComponent("../../src/shared/BookCard.vue", { book })
	const summary = await mountComponent("../../src/list/SelectionSummary.vue", { rows: [{ name: "A" }], refresh: async () => {},
		actions: [{ key: "create-dc", label: "Create DC", permission: ["MGK Delivery Challan", "create"], run: async () => {} }] })
	try {
		assert.equal(textContent(card.root).includes("+ New"), false)
		assert.equal(textContent(summary.root).includes("Create DC"), false)
	} finally { card.close(); summary.close(); globalThis.window = original }
})

test("preview Submit shows a success toast and toast text names the document", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const toasts = []
	bindToast({ add: (message) => toasts.push([message.severity, message.summary, message.life]) })
	const page = await mountSplit({ user: { can_submit: [order] }, preview: { is_submittable: 1, doc: { docstatus: 0, items: [] } },
		respond: (url, options, preview) => url.includes("load.getdoc") ? { docs: [{ ...preview.doc, doctype: order }] }
			: options.method === "POST" ? { ...preview.doc, docstatus: 1 } : preview })
	try {
		context.mock.timers.tick(120); await settle()
		const running = runMenuAction(page, "Submit")
		await settle(); button(page, "Confirm").props.onClick()
		await running; await settle()
		assert.deepEqual(toasts, [["success", "A submitted", 3000]])
	} finally { page.close(); bindToast(null) }
	assert.equal(actionToastText({ message: "Created and submitted:", links: [{ label: "GRN-1" }, { label: "DC-1" }] }), "Created and submitted: GRN-1, DC-1")
	assert.equal(documentToast("MGK-PO-26-00007", "submitted"), "MGK-PO-26-00007 submitted")
})
