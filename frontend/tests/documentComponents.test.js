import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { reactive } from "vue"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { clearReadCaches } from "../src/api/client.js"
import { editorPermissions } from "../src/item-editor/editorModes.js"
import { linkDescription } from "../src/list/linkOptions.js"
import purchaseOrder from "../src/books/purchase-order/config.js"

const inputs = (root) => nodes(root, (node) => node.tag === "input")
const button = (root, label) => nodes(root, (node) => node.tag === "button" && textContent(node) === label)[0]
const user = { name: "Administrator" }

test("Add item restores the editor context's received-type default, including uncommitted picker text", async () => {
	const original = globalThis.fetch
	const committed = []
	globalThis.fetch = async (url) => {
		const message = url.includes("get_attribute_details") ? { attributes: [], default_uom: "Kg" }
			: [{ value: new URL(url, "http://site").searchParams.get("doctype") === "Item" ? "Yarn" : "Rejected" }]
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	const defaults = { received_type: "Accepted" }
	const page = await mountComponent("../../src/item-editor/StockItemEntry.vue", { mode: "po", defaults,
		dimensions: [{ fieldname: "received_type", label: "YRP Received Type", options: "YRP Received Type", mandatory: 1 }],
		permissions: editorPermissions("po"), poEntries: [], onCommit: (details, entry) => committed.push(entry) })
	try {
		for (const selectRejected of [false, true]) {
			const item = inputs(page.root)[0]
			await item.props.onFocus()
			await settle()
			nodes(page.root, (node) => node.tag === "li")[0].props.onMousedown({ preventDefault() {} })
			await settle()
			const receivedType = inputs(page.root)[1]
			if (selectRejected) {
				await receivedType.props.onFocus()
				await settle()
				nodes(page.root, (node) => node.tag === "li")[0].props.onMousedown({ preventDefault() {} })
			} else receivedType.props.onInput({ target: { value: "unselected text" } })
			const numbers = inputs(page.root).filter((node) => node.props.role !== "combobox")
			numbers[0].props.onInput({ target: { value: "2" } })
			numbers[1].props.onInput({ target: { value: "10" } })
			await settle()
			await button(page.root, "Add item").props.onClick()
			await settle()
			assert.equal(inputs(page.root)[0].props.value, "")
			assert.equal(inputs(page.root)[1].props.value, "Accepted")
			assert.equal(inputs(page.root)[0].focused, true)
		}
		assert.deepEqual(committed.map((entry) => entry.dimensions.received_type), ["Accepted", "Rejected"])
		assert.deepEqual(defaults, { received_type: "Accepted" })
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("link suggestions show a description only when it differs from the value", async () => {
	assert.equal(linkDescription({ value: "IE2 Knit Works", description: "<b>IE2 Knit Works</b> " }), "")
	assert.equal(linkDescription({ value: "ITEM-1", description: "<b>Yarn</b>" }), "Yarn")
	const page = await mountComponent("../../src/document/fields/LinkField.vue", { doctype: "Supplier", candidates: [
		{ value: "IE2 Knit Works", description: "IE2 Knit Works" }, { value: "SUP-1", description: "Supplier name" },
	] })
	try {
		await inputs(page.root)[0].props.onFocus()
		await settle()
		const options = nodes(page.root, (node) => node.tag === "li")
		assert.equal(textContent(options[0]), "IE2 Knit Works")
		assert.equal(textContent(options[1]), "SUP-1Supplier name")
	} finally { page.close() }
})

test("list filter link suggestions also omit repeated descriptions", async () => {
	const original = globalThis.fetch
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ message: [{ value: "Vendor", description: "Vendor" }] }) })
	const page = await mountComponent("../../src/list/LinkInput.vue", { doctype: "Supplier" })
	try {
		await inputs(page.root)[0].props.onFocus()
		await settle()
		assert.equal(textContent(nodes(page.root, (node) => node.tag === "li")[0]), "Vendor")
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("Details renders address and contact beneath their owning rows and hides draft close value gaps", async () => {
	const fields = ["supplier_address", "contact_person", "total_value_gap"].map((fieldname) => ({ fieldname, fieldtype: "Data", label: fieldname }))
	const props = reactive({ fields, meta: { permissions: [] }, user, disabled: true, doc: {
		doctype: "MGK Delivery Challan Close", docstatus: 0, supplier_address: "Address-1", address_display: "Road<br>Town",
		contact_person: "Contact-1", contact_display: "Asha", contact_mobile: "12345", total_value_gap: 9,
	} })
	const page = await mountComponent("../../src/document/DetailsPanel.vue", props)
	try {
		const rows = nodes(page.root, (node) => node.props.class === "detail-row")
		assert.equal(rows.length, 2)
		assert.match(textContent(rows[0]), /Address-1Road\nTown/)
		assert.match(textContent(rows[1]), /Contact-1Asha\n12345/)
		props.doc.docstatus = 1
		await settle()
		assert.match(textContent(page.root), /total_value_gap\s*9/)
	} finally { page.close() }
})

test("document actions omit Edit for every status and expose the correct lifecycle actions", async () => {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { user: Object.fromEntries(["write", "submit", "cancel", "delete", "amend"].map((key) => [`can_${key}`, [purchaseOrder.doctype]])) } } }
	const props = reactive({ doc: { doctype: purchaseOrder.doctype, docstatus: 0 }, meta: { is_submittable: 1 }, editing: true, dirty: false })
	const page = await mountComponent("../../src/document/DocumentActions.vue", props)
	try {
		for (const [docstatus, expected] of [[0, ["Delete", "Submit"]], [1, ["Cancel"]], [2, ["Delete", "Amend"]]]) {
			props.doc.docstatus = docstatus
			props.editing = docstatus === 0
			await settle()
			assert.deepEqual(nodes(page.root, (node) => node.tag === "button").map(textContent), expected)
		}
	} finally { page.close(); globalThis.window = original }
})

test("submitted and cancelled hero names include the party without Update", async () => {
	const props = reactive({ book: purchaseOrder, doc: { name: "PO-1", supplier: "Vendor", docstatus: 1 } })
	const page = await mountComponent("../../src/document/DocumentHeader.vue", props)
	try {
		for (const docstatus of [1, 2]) {
			props.doc.docstatus = docstatus
			await settle()
			assert.equal(textContent(nodes(page.root, (node) => node.tag === "h1")[0]), "PO-1 · Vendor")
		}
	} finally { page.close() }
})

test("DC Close tables render child values as text and hide actual valuation columns in drafts", async () => {
	for (const [table, child] of [["items", "item"], ["outputs", "output"]]) {
		const name = `mgk_delivery_challan_close_${child}`
		const meta = JSON.parse(await readFile(new URL(`../../mgk_yrp/mgk_yrp/doctype/${name}/${name}.json`, import.meta.url)))
		const row = Object.fromEntries(meta.fields.map((field) => [field.fieldname, ["Currency", "Float"].includes(field.fieldtype) ? 1234.56789 : `${field.fieldname}-value`]))
		const second = Object.fromEntries(meta.fields.map((field) => [field.fieldname, ["Currency", "Float"].includes(field.fieldtype) ? 0 : `${field.fieldname}-second`]))
		const props = reactive({ field: { fieldname: table, options: meta.name }, metas: [meta], modelValue: [row, second],
			parentDoc: { doctype: "MGK Delivery Challan Close", docstatus: 0 }, parentMeta: { permissions: [] }, user, disabled: true })
		const page = await mountComponent("../../src/document/fields/SimpleTable.vue", props)
		try {
			for (const docstatus of [0, 1, 2]) {
				props.parentDoc.docstatus = docstatus
				await settle()
				const text = textContent(page.root)
				assert.ok(text.includes("item-value"))
				assert.ok(text.includes("item-second"))
				if (table === "items" || docstatus !== 0) assert.ok(text.includes("1,234.57"))
				assert.ok(text.includes("1,234.56789"))
				assert.equal(inputs(page.root).length, 0)
				const hidden = table === "items" ? ["Consumed Value", "Value Gap"] : ["Allocated Value", "Allocated Rate"]
				for (const label of hidden) assert.equal(text.includes(label), docstatus !== 0, label)
				const cells = nodes(page.root, (node) => node.props.class === "read-only-cell")
				const rowIds = meta.fields.filter((field) => field.fieldtype === "Data" && /(?:_item|_row)$/.test(field.fieldname))
				for (const field of rowIds) assert.equal(text.includes(`${field.fieldname}-value`), false)
				assert.equal(cells.length, 2 * (meta.fields.length - rowIds.length - (docstatus === 0 ? 2 : 0)))
				assert.ok(cells.some((cell) => textContent(cell) === "0"))
			}
		} finally { page.close() }
	}
})

test("the GRN editor reloads mapped onload rows when a PO response arrives after mount", async () => {
	const original = globalThis.fetch
	globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ message: url.includes("get_editor_context")
		? { defaults: { received_type: "Accepted" }, po_entries: [] } : [] }) })
	const props = reactive({ doc: { doctype: "MGK Goods Received Note", against_purchase_order: 1, purchase_order: "PO-1",
		docstatus: 0, __onload: { item_details: [] } }, editable: true })
	const counts = []
	props.onLoaded = (count) => counts.push(count)
	const page = await mountComponent("../../src/item-editor/MgkItemEditor.vue", props)
	try {
		await settle()
		assert.ok(textContent(page.root).includes("No items yet"))
		props.doc.__onload.item_details = [{ attributes: [], primary_attribute_values: [], items: [{ name: "Mapped Yarn", default_uom: "Kg",
			values: { default: { qty: 6, rate: 10, purchase_order_item: "source-row", pending_qty: 6, allowed_qty: 6 } } }] }]
		await settle(); await settle()
		assert.ok(textContent(page.root).includes("Mapped Yarn"))
		assert.ok(textContent(page.root).includes("Pending: 6"))
		assert.deepEqual(counts, [0, 1])
		props.doc.against_purchase_order = 0
		props.doc.purchase_order = ""
		props.doc.__onload.item_details = []
		await settle(); await settle()
		assert.ok(textContent(page.root).includes("No items yet"))
		assert.equal(textContent(page.root).includes("Mapped Yarn"), false)
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("PO and GRN amended rows hydrate through the draft editor endpoint before becoming ready", async () => {
	const original = globalThis.fetch
	const requests = []
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options })
		const message = url.includes("get_editor_context") ? { defaults: {}, po_entries: [] }
			: url.includes("get_draft_item_details") ? [{ attributes: [], items: [{ name: "Amended Yarn", values: {
				default: { qty: 2, rate: 5, purchase_order_item: "po-source" },
			} }] }] : []
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	try {
		for (const doctype of ["MGK Purchase Order", "MGK Goods Received Note"]) {
			const doc = { doctype, docstatus: 0, __islocal: 1, amended_from: "CANCELLED-1", purchase_order: "PO-1", against_purchase_order: 1,
				items: [{ item: "Amended Yarn", qty: 2, rate: 5, purchase_order_item: "po-source" }] }
			const page = await mountComponent("../../src/item-editor/MgkItemEditor.vue", { doc, editable: true })
			try {
				await settle(); await settle()
				assert.ok(textContent(page.root).includes("Amended Yarn"))
				const request = requests.filter((request) => request.url.endsWith("get_draft_item_details")).at(-1)
				assert.equal(request.options.method, "POST")
				assert.deepEqual(JSON.parse(JSON.parse(request.options.body).doc), doc)
			} finally { page.close() }
		}
	} finally { globalThis.fetch = original; clearReadCaches() }
})
