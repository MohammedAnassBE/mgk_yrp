import test from "node:test"
import assert from "node:assert/strict"
import { reactive } from "vue"
import { createRouter, createMemoryHistory } from "vue-router"
import { getMaster, masters } from "../src/masters/mastersConfig.js"
import { masterSections } from "../src/masters/masterFields.js"
import { clearReadCaches } from "../src/api/client.js"
import { realtime } from "../src/realtime/socket.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

test("master field controls render the copied toggle on/off wording and configured labels/help", async () => {
	const master = getMaster("items")
	const meta = { name: "Item", fields: [{ fieldname: "mgk_is_salavai_cone", fieldtype: "Check", label: "Is Salavai Cone", description: "ERP description" }] }
	const field = masterSections(master, meta, {}, { name: "Administrator" })[0].fields[0]
	const props = reactive({ field, doc: { mgk_is_salavai_cone: 0 }, meta, metas: [], user: { name: "Administrator" } })
	const page = await mountComponent("../../src/document/fields/FieldControl.vue", props)
	try {
		assert.match(textContent(page.root), /Not a Salavai Cone item/)
		assert.doesNotMatch(textContent(page.root), /ERP description/)
		props.doc.mgk_is_salavai_cone = 1
		await settle()
		assert.match(textContent(page.root), /Salavai Cone item/)
		assert.doesNotMatch(textContent(page.root), /Not a Salavai Cone item/)
	} finally { page.close() }
})

async function mountMaster(master, isNew, broken = false, recordOverrides = {}) {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	Object.assign(realtime, { socket: null, pending: null, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	const permissions = Object.fromEntries(["read", "write", "create", "delete"].map((permission) => [`can_${permission}`, [master.doctype, "Address", "Contact"]]))
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", ...permissions } } }, addEventListener() {}, removeEventListener() {} }
	const fields = master.formOrder.filter((name) => !["name1", "default_unit_of_measure", "mgk_tamil_name"].includes(name))
		.map((fieldname) => ({ fieldname, label: fieldname, fieldtype: "Data" }))
	if (master.doctype === "Warehouse") fields.find((field) => field.fieldname === "supplier").depends_on = "eval:(!doc.is_group);"
	if (broken) fields.find((field) => field.fieldname === "supplier").depends_on = "eval:missing_dependency(doc.is_group);"
	if (master.doctype === "User") fields.find((field) => field.fieldname === "send_welcome_email").depends_on = "eval:in_list(['System User', 'Website User'], doc.user_type) && doc.enabled == 1"
	const meta = { name: master.doctype, fields: [...fields, { fieldname: "noise", fieldtype: "Data" }] }
	const record = { doctype: master.doctype, name: "REC-001", [master.titleFields[0]]: "Record title", enabled: 1, user_type: "System User", ...recordOverrides }
	const requests = []
	globalThis.fetch = async (url) => {
		requests.push(url)
		const response = url.includes("getdoctype") ? { docs: [meta] } : url.includes("getdoc") ? { docs: [record] } : { message: [] }
		return { ok: true, status: 200, json: async () => structuredClone(response) }
	}
	const router = createRouter({ history: createMemoryHistory(), routes: ["/manage/:master/new", "/manage/:master/:name", "/:pathMatch(.*)*"].map((path) => ({ path, component: { render: () => null } })) })
	await router.push(`${master.route}/${isNew ? "new" : "REC-001"}`)
	const page = await mountComponent("../../src/masters/MasterEntry.vue", { master }, [router])
	await settle()
	return { ...page, requests, close() { page.close(); globalThis.window = original.window; globalThis.fetch = original.fetch; Object.assign(realtime, original.realtime); clearReadCaches() } }
}

test("all eight new and edit forms render numbered configured sections and the master hero", async () => {
	for (const master of masters) for (const isNew of [true, false]) {
		const page = await mountMaster(master, isNew)
		try {
			const hero = nodes(page.root, (node) => node.tag === "h1" && node.props.class === "doc-hero")
			assert.equal(hero.length, 1, `${master.key} ${isNew}`)
			assert.equal(textContent(hero[0]), isNew ? `Create a new ${master.entityLabel.toLowerCase()}` : "Record title")
			assert.equal(textContent(nodes(page.root, (node) => node.props.class === "book-entry-kicker")[0]), `${master.entityLabel} Master`)
			assert.match(textContent(page.root), new RegExp(master.description.replaceAll(".", "\\.")))
			const steps = nodes(page.root, (node) => node.props.class === "book-step").map(textContent)
			assert.deepEqual(steps, steps.map((_, index) => String(index + 1)))
			assert.ok(steps.length > 0)
			assert.doesNotMatch(textContent(page.root), /Unable to open master|Could not evaluate|Update REC/)
			if (master.party && !isNew) {
				assert.ok(nodes(page.root, (node) => node.tag === "h2" && textContent(node) === "Addresses and contacts").length)
				assert.ok(page.requests.some((url) => url.includes("frappe.client.get_list")))
			}
		} finally { page.close() }
	}
})

test("master forms lead back through Manage and their master list", async () => {
	for (const master of masters) {
		const page = await mountMaster(master, false)
		try {
			const crumbs = nodes(nodes(page.root, (node) => node.tag === "nav")[0], (node) => node.tag === "a").map((node) => [textContent(node), node.props.href])
			assert.deepEqual(crumbs, [["All books", "/"], ["Manage", "/manage"], [master.label, master.route]], master.key)
			assert.deepEqual(nodes(page.root, (node) => node.props.class === "head-back").map((node) => node.props.href), [master.route], master.key)
		} finally { page.close() }
	}
})

test("a variant URL renders its encoded template link instead of the master form", async () => {
	const page = await mountMaster(getMaster("items"), false, false, { variant_of: "Template / 1" })
	try {
		assert.match(textContent(page.root), /Variants are managed from their template Template \/ 1/)
		assert.equal(nodes(page.root, (node) => node.tag === "a" && node.props.href === "/manage/items/Template%20%2F%201").length, 1)
		assert.equal(nodes(page.root, (node) => node.props.class === "form-layout").length, 0)
		assert.equal(nodes(page.root, (node) => node.tag === "button").length, 0)
	} finally { page.close() }
})

test("Manage counts use the same Item base and OR filters as the list", async () => {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	Object.assign(realtime, { socket: null, pending: null, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	globalThis.window = { frappe: { boot: { user: { name: "Administrator", can_read: ["Item"] } } } }
	const requests = []
	globalThis.fetch = async (url) => {
		requests.push(url)
		return { ok: true, status: 200, json: async () => ({ message: [3] }) }
	}
	const page = await mountComponent("../../src/books/masters/MastersListPage.vue", {})
	try {
		const counts = requests.find((url) => url.includes("get_counts"))
		const sets = JSON.parse(new URL(counts, "http://site").searchParams.get("doctype_filter_sets"))
		assert.deepEqual(sets, [{ doctype: "Item", filters: [["variant_of", "is", "not set"]], or_filters: [["has_variants", "=", 1], ["disabled", "=", 0]] }])
		assert.match(textContent(page.root), /3 records/)
	} finally { page.close(); globalThis.window = original.window; globalThis.fetch = original.fetch; Object.assign(realtime, original.realtime); clearReadCaches() }
})

test("a condition that still fails leaves the master page and other fields available and logs one diagnostic", async (t) => {
	const logger = t.mock.method(console, "error", () => {})
	for (const isNew of [true, false]) {
		const page = await mountMaster(getMaster("warehouses"), isNew, true)
		try {
			assert.equal(nodes(page.root, (node) => node.tag === "h1").length, 1)
			assert.ok(nodes(page.root, (node) => node.tag === "h2" && textContent(node) === "Warehouse identity").length)
		} finally { page.close() }
	}
	assert.equal(logger.mock.callCount(), 1)
	assert.match(logger.mock.calls[0].arguments[0], /Warehouse\.supplier: eval:missing_dependency/)
})
