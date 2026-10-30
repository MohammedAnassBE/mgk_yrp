import test from "node:test"
import assert from "node:assert/strict"
import { createRenderer, nextTick } from "vue"
import { createRouter, createMemoryHistory } from "vue-router"
import { clearReadCaches } from "../src/api/client.js"
import { realtime } from "../src/realtime/socket.js"
import { useDocument } from "../src/document/useDocument.js"
import billing from "../src/books/billing/config.js"
import purchaseOrder from "../src/books/purchase-order/config.js"
import goodsReceivedNote from "../src/books/goods-received-note/config.js"
import { readMappedDraft, stageMappedDraft } from "../src/document/mappedDraft.js"
import { FakeSocket } from "./helpers/fakeSocket.js"

const renderer = createRenderer({ createComment: (text) => ({ text }), createText: (text) => ({ text }), insert: () => {}, remove: () => {}, setText: () => {}, parentNode: () => null, nextSibling: () => null })
async function settle() { await nextTick(); await new Promise(setImmediate); await nextTick() }

async function context({ book = billing, path = `${book.routePath}/PI-1`, record, fields = [], canWrite = true, methods = {}, boot = {} } = {}) {
	const originals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, realtime: { ...realtime } }
	const permissions = [book.doctype]
	const user = Object.fromEntries(["read", "create", "write", "submit", "cancel", "amend", "delete"].map((key) => [`can_${key}`, key === "write" && !canWrite ? [] : permissions]))
	const store = new Map()
	const socket = new FakeSocket()
	const requests = []
	const apps = []
	let saved = record || { doctype: book.doctype, name: "PI-1", docstatus: 0, modified: "one", note: "initial", __onload: { valuation_pending: false } }
	let conflict = false
	let readGate = null
	Object.assign(realtime, { socket: null, pending: null, connectedBefore: false, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => socket })
	globalThis.window = { csrf_token: "csrf", frappe: { boot: { ...boot, user: { ...user, roles: ["Tester"], name: "tester", ...boot.user } } }, scrollY: 400,
		scrollTo: ({ top }) => { window.scrollY = top }, addEventListener: () => {}, removeEventListener: () => {},
		sessionStorage: { getItem: (key) => store.get(key), setItem: (key, value) => store.set(key, value) } }
	globalThis.document = { cookie: "", querySelector: () => null }
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options })
		let response
		const method = new URL(url, "http://site").pathname.split("/").at(-1)
		if (methods[method]) response = await methods[method](url, options)
		else if (url.includes("getdoctype")) response = { docs: [{ name: book.doctype, fields: [{ fieldname: "note", fieldtype: "Data", label: "Note" }, ...fields], permissions: [{ role: "Tester", read: 1, write: 1 }], is_submittable: 1 }] }
		else if (url.includes("getdoc")) { if (readGate) await readGate; response = { docs: [saved] } }
		else if (url.includes("get_own_location")) response = { message: { location: null, warehouse: null, warehouses: [] } }
		else if (url.includes("party_defaults")) response = { message: { warehouses: [], addresses: [], contacts: [] } }
		else if (url.endsWith("frappe.client.save")) {
			if (conflict) return { ok: false, status: 417, json: async () => ({ exc_type: "TimestampMismatchError" }) }
			saved = { ...JSON.parse(options.body).doc, name: saved.name, modified: "saved", __islocal: 0 }
			response = { message: saved }
		} else if (url.endsWith("frappe.client.cancel")) {
			saved = { ...saved, docstatus: 2, modified: "cancelled", __onload: { valuation_pending: true } }
			response = { message: saved }
		} else if (url.endsWith("frappe.client.submit")) {
			saved = { ...saved, docstatus: 1, modified: "submitted" }
			response = { message: saved }
		} else response = { message: null }
		return { ok: true, status: 200, json: async () => structuredClone(response) }
	}
	async function open(target = path) {
		let model
		const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `${book.routePath}/new`, component: { render: () => null } }, { path: `${book.routePath}/:name`, component: { render: () => null } }, { path: book.routePath, component: { render: () => null } }] })
		await router.push(target)
		const app = renderer.createApp({ setup() { model = useDocument(book); return () => null } })
		app.use(router).mount({})
		apps.push(app)
		await settle()
		return { model, router }
	}
	const first = await open()
	return { ...first, open, requests, socket, saved: () => saved, setSaved: (value) => { saved = value }, conflict: () => { conflict = true },
		abandon: () => { apps.splice(0).forEach((app) => app.unmount()) },
		holdReads: () => { let release; readGate = new Promise((resolve) => { release = resolve }); return () => { readGate = null; release() } },
		close: () => { apps.forEach((app) => app.unmount()); Object.assign(realtime, originals.realtime); Object.assign(globalThis, { window: originals.window, document: originals.document, fetch: originals.fetch }); clearReadCaches() } }
}

test("delayed new-document saves cannot apply or navigate after route replacement or disposal", async () => {
	for (const dispose of [false, true]) {
		let finish
		const page = await context({ path: "/billing/new", methods: {
			"frappe.client.save": () => new Promise((resolve) => { finish = () => resolve({ message: { doctype: billing.doctype, name: "SAVED-1", docstatus: 0 } }) }),
		} })
		try {
			page.model.change("note", "new invoice")
			const pending = page.model.save()
			await settle()
			if (dispose) page.abandon()
			await page.router.push("/billing/OTHER")
			await settle()
			const record = page.model.doc.value
			finish(); await pending
			assert.equal(page.router.currentRoute.value.path, "/billing/OTHER")
			assert.equal(page.model.doc.value, record)
		} finally { finish?.(); page.close() }
	}
})

test("delayed mapping never stages or navigates a draft after its source page was abandoned", async () => {
	let finish
	const page = await context({ book: purchaseOrder, record: { doctype: purchaseOrder.doctype, name: "PO-1", docstatus: 1, items: [{ pending_qty: 2 }] },
		boot: { user: { can_create: [purchaseOrder.doctype, goodsReceivedNote.doctype] } }, methods: {
			"frappe.model.mapper.make_mapped_doc": () => new Promise((resolve) => { finish = () => resolve({ message: { doctype: goodsReceivedNote.doctype } }) }),
		} })
	try {
		const pending = page.model.action("create-grn")
		await settle()
		await page.router.push("/purchase-order/OTHER")
		await settle()
		finish(); await pending
		assert.equal(page.router.currentRoute.value.path, "/purchase-order/OTHER")
		assert.equal(page.router.currentRoute.value.query.draft, undefined)
	} finally { finish?.(); page.close() }
})

test("room acknowledgement catches an update committed after the initial document snapshot", async () => {
	let finish, reads = 0
	let saved = { doctype: billing.doctype, name: "PI-1", docstatus: 0, note: "pre-commit" }
	const page = await context({ methods: {
		"frappe.desk.form.load.getdoc": async () => {
			const snapshot = structuredClone(saved)
			if (++reads === 1) await new Promise((resolve) => { finish = resolve })
			return { docs: [snapshot] }
		},
	} })
	try {
		assert.equal(reads, 1)
		assert.equal(page.model.loading.value, true)
		saved.note = "committed before membership"
		const subscription = page.socket.emitted.find((args) => args[0] === "mgk_doc_subscribe")
		subscription.at(-1)()
		finish(); await settle(); await settle()
		assert.equal(page.model.doc.value.note, "committed before membership")
		assert.equal(reads, 2)
		assert.equal(page.model.loading.value, false)
	} finally { finish?.(); page.close() }
})

test("saved document uses getdoc with onload, Save sends the full document, cancel re-reads valuation onload", async () => {
	const page = await context()
	try {
		assert.equal(page.model.doc.value.__onload.valuation_pending, false)
		assert.equal(page.model.dirty.value, false)
		page.model.change("note", "edited")
		await page.model.save()
		const write = page.requests.find((row) => row.url.endsWith("frappe.client.save"))
		assert.equal(JSON.parse(write.options.body).doc.note, "edited")
		assert.equal(page.model.dirty.value, false)
		await page.model.action("submit")
		assert.equal(page.model.doc.value.docstatus, 1)
		await page.model.action("cancel")
		assert.equal(page.model.doc.value.docstatus, 2)
		assert.equal(page.model.doc.value.__onload.valuation_pending, true)
		await page.model.action("amend")
		assert.match(page.model.error.value, /Wait for valuation/)
		page.setSaved({ ...page.saved(), __onload: { valuation_pending: false } })
		await page.model.action("amend")
		const draft = readMappedDraft(page.router.currentRoute.value.query.draft, billing.doctype)
		assert.equal(draft.amended_from, "PI-1")
		assert.equal(draft.__islocal, 1)
	} finally { page.close() }
})

test("transactions use shared boot defaults only for new documents and preserve mapped values", async () => {
	const page = await context({ fields: [{ fieldname: "company", fieldtype: "Link", options: "Company" },
		{ fieldname: "against", fieldtype: "Select", reqd: 1, options: "Purchase Order\nJob Work" }],
		boot: { defaults: { company: "Essdee India" } } })
	try {
		assert.equal(page.model.doc.value.company, undefined)
		const fresh = await page.open(`${billing.routePath}/new`)
		assert.equal(fresh.model.doc.value.company, "Essdee India")
		assert.equal(fresh.model.doc.value.against, "Purchase Order")
		const token = stageMappedDraft({ doctype: billing.doctype, company: "Mapped Company", against: "Job Work" })
		const mapped = await page.open(`${billing.routePath}/new?draft=${token}`)
		assert.equal(mapped.model.doc.value.company, "Mapped Company")
		assert.equal(mapped.model.doc.value.against, "Job Work")
	} finally { page.close() }
})

test("drafts open and remain editable after save and discard; submitted and cancelled documents cannot save", async () => {
	const page = await context()
	try {
		assert.equal(page.model.editing.value, true)
		page.model.change("note", "edited")
		await page.model.save()
		assert.equal(page.model.editing.value, true)
		page.model.change("note", "discard me")
		await page.model.reload()
		assert.equal(page.model.doc.value.note, "edited")
		assert.equal(page.model.editing.value, true)
		for (const docstatus of [1, 2]) {
			page.setSaved({ ...page.saved(), docstatus })
			await page.model.reload()
			assert.equal(page.model.editing.value, false)
			page.model.change("note", "cannot save")
			await page.model.save()
		}
		assert.equal(page.requests.filter((row) => row.url.endsWith("frappe.client.save")).length, 1)
	} finally { page.close() }
})

test("submit and cancel apply the server response while the onload reload is still pending", async () => {
	const page = await context()
	let release
	try {
		for (const [action, docstatus] of [["submit", 1], ["cancel", 2]]) {
			release = page.holdReads()
			const pending = page.model.action(action)
			await settle()
			assert.equal(page.model.doc.value.docstatus, docstatus)
			assert.equal(page.model.editing.value, false)
			assert.equal(page.model.dirty.value, false)
			release()
			await pending
		}
	} finally { release?.(); page.close() }
})

test("opening submitted and cancelled documents never fetches party defaults", async () => {
	for (const docstatus of [1, 2]) {
		const page = await context({ record: { doctype: billing.doctype, name: "PI-1", docstatus, supplier: "Vendor" } })
		try {
			assert.equal(page.model.editing.value, false)
			assert.equal(page.requests.some((row) => row.url.includes("party_defaults")), false)
		} finally { page.close() }
	}
})

test("drafts without write permission stay read-only and do not fetch party defaults", async () => {
	const page = await context({ canWrite: false, record: { doctype: billing.doctype, name: "PI-1", docstatus: 0, supplier: "Vendor" } })
	try {
		assert.equal(page.model.editing.value, false)
		assert.equal(page.requests.some((row) => row.url.includes("party_defaults")), false)
	} finally { page.close() }
})

test("required panel fields block Save with their names before any write", async () => {
	const page = await context({ fields: [{ fieldname: "warehouse", fieldtype: "Link", label: "Warehouse", options: "Warehouse", reqd: 1 }] })
	try {
		page.model.change("note", "edited")
		await page.model.save()
		assert.deepEqual(page.model.required.value, ["Warehouse"])
		assert.equal(page.model.error.value, "")
		assert.equal(page.requests.filter((row) => row.url.endsWith("frappe.client.save")).length, 0)
	} finally { page.close() }
})

test("PO Save serializes item_details with items empty and refuses hydration still in progress", async () => {
	const page = await context({ book: purchaseOrder })
	try {
		page.model.change("note", "edited")
		await page.model.save()
		assert.match(page.model.error.value, /still loading/)
		page.model.editorReady.value = true
		page.model.itemEditor.value = { isReady: () => true, getItems: () => [{ items: [{ values: { default: { name: "child", qty: 2, rate: 5, extra: "keep" } } }] }] }
		await page.model.save()
		const payload = JSON.parse(page.requests.find((row) => row.url.endsWith("frappe.client.save")).options.body).doc
		assert.deepEqual(payload.items, [])
		assert.equal(JSON.parse(payload.item_details)[0].items[0].values.default.extra, "keep")
	} finally { page.close() }
})

test("two open contexts see a save immediately after their own save; unchanged timestamps still reload", async (t) => {
	const page = await context()
	t.mock.timers.enable({ apis: ["setTimeout"] })
	try {
		const second = await page.open()
		page.model.change("note", "A saved")
		await page.model.save()
		await second.model.reload()
		second.model.change("note", "B saved immediately")
		await second.model.save()
		page.socket.fire("doc_update", { doctype: billing.doctype, name: "PI-1", modified: "saved" })
		t.mock.timers.tick(300); await settle()
		assert.equal(page.model.doc.value.note, "B saved immediately")
		assert.equal(window.scrollY, 400)
		page.setSaved({ ...page.saved(), note: "db_set kept modified" })
		page.socket.fire("doc_update", { doctype: billing.doctype, name: "PI-1", modified: "saved" })
		t.mock.timers.tick(300); await settle()
		assert.equal(page.model.doc.value.note, "db_set kept modified")
	} finally { page.close() }
})

test("dirty live events and TimestampMismatch show the same sticky stale banner until Reload", async (t) => {
	const page = await context()
	t.mock.timers.enable({ apis: ["setTimeout"] })
	try {
		page.model.change("note", "my unsaved edit")
		page.socket.fire("doc_update", { doctype: billing.doctype, name: "PI-1" })
		t.mock.timers.tick(300); await settle()
		assert.equal(page.model.stale.value, true)
		assert.equal(page.model.doc.value.note, "my unsaved edit")
		await page.model.reload()
		assert.equal(page.model.stale.value, false)
		page.model.change("note", "another edit")
		page.conflict()
		await page.model.save()
		assert.equal(page.model.stale.value, true)
		assert.equal(page.model.dirty.value, true)
	} finally { page.close() }
})

test("PO supplier defaults trigger Desk companion lookups and delivery location clears the old warehouse", async () => {
	const fields = ["supplier", "supplier_address", "contact_person", "delivery_location", "warehouse"].map((fieldname) => ({ fieldname, fieldtype: "Link" }))
	const page = await context({ book: purchaseOrder, fields, methods: {
		"mgk_yrp.party_defaults.get_party_defaults": async () => ({ message: {
			addresses: ["Address"], address: "Address", contacts: ["Contact"], contact: "Contact", warehouses: ["New warehouse"], warehouse: "New warehouse",
		} }),
		"frappe.contacts.doctype.address.address.get_address_display": async () => ({ message: "Road<br>Town" }),
		"frappe.contacts.doctype.contact.contact.get_contact_details": async () => ({ message: { contact_display: "Asha", contact_mobile: "123" } }),
	} })
	try {
		page.model.change("supplier", "Vendor")
		await settle(); await settle()
		assert.equal(page.model.doc.value.supplier_address, "Address")
		assert.equal(page.model.doc.value.address_display, "Road<br>Town")
		assert.equal(page.model.doc.value.contact_person, "Contact")
		assert.equal(page.model.doc.value.contact_display, "Asha")
		assert.equal(page.model.doc.value.contact_mobile, "123")
		page.model.doc.value.warehouse = "Old warehouse"
		page.model.change("delivery_location", "Own")
		assert.equal(page.model.doc.value.warehouse, "")
		await settle(); await settle()
		assert.equal(page.model.doc.value.warehouse, "New warehouse")
		assert.ok(page.model.party.autoFields.value.includes("warehouse"))
	} finally { page.close() }
})

test("GRN PO selection posts the Desk mapper, blocks Save until it resolves, and source toggle discards mapped data", async () => {
	let resolve
	const mapped = new Promise((done) => { resolve = done })
	const page = await context({ book: goodsReceivedNote, record: { doctype: goodsReceivedNote.doctype, name: "GRN-1", docstatus: 0, against_purchase_order: 1 },
		methods: { "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.make_goods_received_note": async () => ({ message: await mapped }) } })
	try {
		page.model.change("purchase_order", "PO-1")
		assert.equal(page.model.fieldsLoading.value, true)
		await page.model.save()
		assert.match(page.model.error.value, /details are still loading/)
		assert.equal(page.requests.some((request) => request.url.endsWith("frappe.client.save")), false)
		resolve({ supplier: "Vendor", delivery_location: "Own", warehouse: "Main", total_qty: 4, total_amount: 20,
			__onload: { item_details: [{ items: [{ name: "Yarn" }] }] } })
		await settle(); await settle()
		assert.equal(page.model.fieldsLoading.value, false)
		assert.equal(page.model.doc.value.supplier, "Vendor")
		assert.ok(page.model.party.autoFields.value.includes("delivery_location"))
		assert.ok(page.model.party.autoFields.value.includes("warehouse"))
		assert.equal(page.model.doc.value.__onload.item_details[0].items[0].name, "Yarn")
		const request = page.requests.find((request) => request.url.endsWith("make_goods_received_note"))
		assert.equal(request.options.method, "POST")
		assert.deepEqual(JSON.parse(request.options.body), { source_name: "PO-1" })
		page.model.change("against_purchase_order", 0)
		assert.equal(page.model.doc.value.purchase_order, "")
		assert.equal(page.model.doc.value.total_qty, 0)
		assert.deepEqual(page.model.doc.value.__onload.item_details, [])
	} finally { resolve({}); page.close() }
})

test("PO and GRN cancellation blocker text reaches the error banner verbatim", async () => {
	for (const book of [purchaseOrder, goodsReceivedNote]) {
		const message = book === purchaseOrder ? "Cancel Goods Received Note GRN-1 before this order."
			: "Delivery Challan DC-1 is closed; reopen it before cancelling this GRN."
		const page = await context({ book, record: { doctype: book.doctype, name: "DOC-1", docstatus: 1 },
			methods: { "frappe.client.cancel": async () => { throw new Error(message) } } })
		try {
			await page.model.action("cancel")
			assert.equal(page.model.error.value, message)
			assert.equal(page.model.doc.value.docstatus, 1)
		} finally { page.close() }
	}
})

test("PO and GRN amendments navigate to their own new routes with source links and copied rows", async () => {
	for (const book of [purchaseOrder, goodsReceivedNote]) {
		const record = { doctype: book.doctype, name: "CANCELLED-1", docstatus: 2, purchase_order: "PO-1", against_purchase_order: 1,
			items: [{ name: "old-row", item: "Yarn", qty: 2, rate: 5, purchase_order_item: "po-source", received_type: "Rejected" }], __onload: { item_details: "old" } }
		const page = await context({ book, record })
		try {
			await page.model.action("amend")
			await settle()
			assert.equal(page.router.currentRoute.value.path, `${book.routePath}/new`)
			const draft = readMappedDraft(page.router.currentRoute.value.query.draft, book.doctype)
			assert.equal(draft.amended_from, record.name)
			assert.equal(draft.docstatus, 0)
			assert.equal(draft.__onload, undefined)
			assert.equal(draft.items[0].name, undefined)
			assert.equal(draft.items[0].purchase_order_item, "po-source")
			assert.equal(draft.items[0].received_type, "Rejected")
			assert.equal(page.model.doc.value.amended_from, record.name)
		} finally { page.close() }
	}
})

test("Close saved and staged drafts run server preview through run_doc_method and block Save while preview loads", async () => {
	const book = { doctype: "MGK Delivery Challan Close", routePath: "/delivery-challan-close" }
	let finish
	const calls = []
	const page = await context({ book, record: { doctype: book.doctype, name: "CLOSE-1", docstatus: 0, delivery_challan: "DC-1" },
		fields: [{ fieldname: "delivery_challan", fieldtype: "Link" }], methods: {
			run_doc_method: async (url, options) => {
				const body = JSON.parse(options.body), doc = JSON.parse(body.docs)
				calls.push(body.method)
				if (doc.delivery_challan === "DC-2") await new Promise((resolve) => { finish = resolve })
				return { docs: [{ ...doc, supplier: "Worker", items: [{ item: "Yarn" }], outputs: [{ item: "Fabric" }], value_per_unit: 10 }] }
			},
		} })
	try {
		assert.deepEqual(calls, ["preview"])
		assert.equal(page.model.doc.value.supplier, "Worker")
		const token = stageMappedDraft({ doctype: book.doctype, delivery_challan: "DC-2" })
		const draft = await page.open(`/delivery-challan-close/new?draft=${token}`)
		assert.equal(draft.model.fieldsLoading.value, true)
		await draft.model.save()
		assert.match(draft.model.error.value, /details are still loading/)
		finish(); await settle(); await settle()
		assert.equal(draft.model.fieldsLoading.value, false)
		assert.equal(draft.model.doc.value.outputs[0].item, "Fabric")
		assert.deepEqual(calls, ["preview", "preview"])
	} finally { finish?.(); page.close() }
})

test("failed Close previews show a retryable details error without allowing Save of an old preview", async () => {
	const book = { doctype: "MGK Delivery Challan Close", routePath: "/delivery-challan-close" }
	let attempts = 0
	const page = await context({ book, record: { doctype: book.doctype, name: "CLOSE-1", docstatus: 0, delivery_challan: "DC-1" }, methods: {
		run_doc_method: async () => { if (++attempts === 1) throw new Error("Source is closed."); return { docs: [{ supplier: "Worker" }] } },
	} })
	try {
		assert.equal(page.model.fieldError.value, "Source is closed.")
		page.model.change("note", "changed")
		await page.model.save()
		assert.equal(page.model.error.value, "Source is closed.")
		assert.equal(page.requests.some((request) => request.url.endsWith("frappe.client.save")), false)
		await page.model.retryFields()
		assert.equal(page.model.fieldError.value, "")
		assert.equal(page.model.doc.value.supplier, "Worker")
	} finally { page.close() }
})

test("Billing in-place cancel hides Amend until a fresh getdoc supplies valuation_pending even if cancel omitted onload", async () => {
	const page = await context({ record: { doctype: billing.doctype, name: "PI-1", docstatus: 1 }, methods: {
		"frappe.client.cancel": async () => ({ message: { doctype: billing.doctype, name: "PI-1", docstatus: 2 } }),
	} })
	let release
	try {
		release = page.holdReads()
		const pending = page.model.action("cancel")
		await settle()
		assert.equal(page.model.doc.value.docstatus, 2)
		assert.equal(page.model.doc.value.__onload.valuation_pending, true)
		page.setSaved({ doctype: billing.doctype, name: "PI-1", docstatus: 2, __onload: { valuation_pending: true } })
		release(); await pending
		assert.equal(page.model.doc.value.__onload.valuation_pending, true)
		await page.model.action("amend")
		assert.match(page.model.error.value, /Wait for valuation/)
		assert.equal(page.router.currentRoute.value.path, "/billing/PI-1")
	} finally { release?.(); page.close() }
})
