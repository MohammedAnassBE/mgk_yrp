import test from "node:test"
import assert from "node:assert/strict"
import { h, ref } from "vue"
import { callMethod } from "../src/api/client.js"
import { documentModule } from "../src/documents/registry.js"
import { button, mountSplit, options, runMenuAction } from "./helpers/splitList.js"
import { nodes, settle, textContent } from "./helpers/component.js"

const previews = (page) => page.requests.filter((url) => url.includes("get_preview"))
async function tick(context, delay) { context.mock.timers.tick(delay); await settle() }
function emitUpdates(page) {
	page.socket.fire("doc_update", { doctype: page.props.doctype, name: "A" })
	page.socket.fire("list_update", { doctype: page.props.doctype })
}

function editingDialog() {
	return {
		emits: ["done", "close"],
		setup(_props, { emit }) {
			const value = ref("")
			return () => h("form", {}, [
				h("input", { value: value.value, onInput: (event) => { value.value = event.target.value } }),
				h("button", { type: "button", onClick: async () => {
					await callMethod("save_plan", { value: value.value })
					emit("done", { message: "Plan saved." })
				} }, "Save plan"),
				h("button", { type: "button", onClick: () => emit("close") }, "Close plan"),
			])
		},
	}
}

test("realtime doc/list events preserve dialog inputs and reload once after close", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const module = documentModule("MGK Purchase Order"), original = module.actions
	module.actions = () => [{ key: "plan", label: "Edit plan", dialog: async () => editingDialog() }]
	const page = await mountSplit()
	try {
		await tick(context, 120)
		await runMenuAction(page, "Edit plan"); await settle()
		const input = nodes(page.root, (node) => node.tag === "input" && node.props.type !== "checkbox")[0]
		input.props.onInput({ target: { value: "Entered plan" } }); await settle()
		emitUpdates(page)
		page.props.rows = page.props.rows.map((row) => ({ ...row, modified: "two" }))
		await settle(); await tick(context, 600)
		assert.equal(previews(page).length, 1)
		assert.equal(input.parent !== null, true)
		assert.equal(input.props.value, "Entered plan")
		assert.ok(button(page, "Close plan"))
		assert.doesNotMatch(textContent(page.root), /Loading preview/)
		button(page, "Close plan").props.onClick(); await settle()
		await tick(context, 300)
		assert.equal(previews(page).length, 2)
		assert.equal(button(page, "Close plan"), undefined)
	} finally { page.close(); module.actions = original }
})

test("realtime updates during dialog submission wait for success without duplicate refreshes", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const module = documentModule("MGK Purchase Order"), original = module.actions
	module.actions = () => [{ key: "plan", label: "Edit plan", dialog: async () => editingDialog() }]
	let finish, refreshes = 0
	const page = await mountSplit({ respond: (url, _options, message) => url.endsWith("save_plan")
		? new Promise((resolve) => { finish = resolve }) : message })
	try {
		page.props.refresh = async () => { refreshes++ }
		await tick(context, 120)
		await runMenuAction(page, "Edit plan"); await settle()
		const pending = button(page, "Save plan").props.onClick(); await settle()
		emitUpdates(page); await tick(context, 600)
		assert.equal(previews(page).length, 1)
		assert.ok(button(page, "Save plan"))
		assert.doesNotMatch(textContent(page.root), /Loading preview/)
		finish({}); await pending; await settle(); await tick(context, 600)
		assert.equal(refreshes, 1)
		assert.equal(previews(page).length, 2)
		assert.match(textContent(page.root), /Plan saved\./)
	} finally { finish?.({}); page.close(); module.actions = original }
})

test("a successful mutation settles its original document after selection changes without realtime", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	let finish, refreshes = 0, is_cancelled = false
	const page = await mountSplit({ user: { can_cancel: ["MGK Purchase Order"] }, respond: (url, _options, message) => {
		if (url.endsWith("frappe.client.cancel")) return new Promise((resolve) => { finish = () => { is_cancelled = true; resolve({}) } })
		return { ...message, doc: { ...message.doc, docstatus: message.doc.name === "A" && is_cancelled ? 2 : 1,
			status: message.doc.name === "A" && is_cancelled ? "Cancelled" : "To Receive" } }
	} })
	try {
		page.props.refresh = async () => { refreshes++ }
		await tick(context, 120)
		const pending = runMenuAction(page, "Cancel"); await settle()
		button(page, "Confirm").props.onClick(); await settle()
		await options(page)[1].props.onClick(); await settle(); await tick(context, 120)
		assert.equal(page.props.selected, "B")
		finish(); await pending; await settle()
		assert.equal(refreshes, 1)
		assert.doesNotMatch(textContent(page.root), /A cancelled\./)
		assert.equal(previews(page).length, 2)
		await options(page)[0].props.onClick(); await settle(); await tick(context, 120)
		assert.equal(previews(page).length, 3)
		const article = nodes(page.root, (node) => node.tag === "article")[0]
		assert.match(textContent(article), /Cancelled/)
		assert.doesNotMatch(textContent(article), /A cancelled\./)
	} finally { finish?.(); page.close() }
})

test("GRN keeps the pending intro and required Bill status, and DC Close keeps Reopen status", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	for (const doctype of ["MGK Goods Received Note", "MGK Delivery Challan Close"]) {
		const page = await mountSplit({ doctype, preview: {
			doc: { docstatus: 1, is_internal_transfer: 1, transfer_status: "In Transit", reopen_status: "Reversing" },
			items: [{ item: "Yarn", qty: 10, transferred_qty: 3, returned_qty: 4, conversion_factor: 2, uom: "Kg" }],
		} })
		try {
			await tick(context, 120)
			const article = nodes(page.root, (node) => node.tag === "article")[0]
			assert.match(textContent(article), doctype === "MGK Goods Received Note" ? /Bill status.*Pending in transit: Yarn 5 Kg/ : /Reopen statusReversing/)
		} finally { page.close() }
	}
})
