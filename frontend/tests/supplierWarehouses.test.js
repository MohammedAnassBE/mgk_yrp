import test from "node:test"
import assert from "node:assert/strict"
import { createRouter, createMemoryHistory } from "vue-router"
import { supplierWarehouseDraft } from "../src/masters/masterFields.js"
import { bindToast } from "../src/shared/notify.js"
import { realtime } from "../src/realtime/socket.js"
import { clearReadCaches } from "../src/api/client.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

test("supplier warehouse draft prefills supplier, name and the only company", () => {
	const supplier = { name: "SUP-1", supplier_name: "IE2 Knit Works" }
	assert.deepEqual(supplierWarehouseDraft(supplier, [{ name: "MGK" }]), { supplier: "SUP-1", warehouse_name: "IE2 Knit Works", is_group: 0, company: "MGK" })
	assert.equal(supplierWarehouseDraft(supplier, [{ name: "A" }, { name: "B" }]).company, undefined)
})

test("Create Warehouse opens a popup that creates several supplier warehouses in place and refreshes the list", async () => {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	const permissions = Object.fromEntries(["read", "create", "write"].map((key) => [`can_${key}`, ["Supplier", "Warehouse", "Company"]]))
	globalThis.window = { frappe: { boot: { user: { name: "Tester", ...permissions } } }, addEventListener() {}, removeEventListener() {} }
	Object.assign(realtime, { socket: null, pending: null, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	const toasts = []
	bindToast({ add: (toast) => toasts.push(toast) })
	const warehouses = []
	const insertions = []
	globalThis.fetch = async (url, options) => {
		const parameters = new URL(url, "http://site").searchParams
		let response
		if (url.includes("get_list") && parameters.get("doctype") === "Company") response = { message: [{ name: "MGK" }] }
		else if (url.includes("get_list")) {
			const filters = JSON.parse(parameters.get("filters"))
			response = { message: warehouses.filter((row) => row.supplier === filters.supplier) }
		} else if (url.endsWith("frappe.client.insert")) {
			const doc = JSON.parse(options.body).doc
			insertions.push(doc)
			const record = { ...doc, name: `${doc.warehouse_name} - MGK` }
			warehouses.push(record)
			response = { message: record }
		} else throw new Error(`Unexpected request: ${url}`)
		return { ok: true, status: 200, json: async () => structuredClone(response) }
	}
	const router = createRouter({ history: createMemoryHistory("/web/"), routes: [{ path: "/manage/:master/:name", component: { render: () => null } }] })
	const supplier = { doctype: "Supplier", name: "IE2 Knit Works", supplier_name: "IE2 Knit Works" }
	const path = `/manage/suppliers/${encodeURIComponent(supplier.name)}`
	let page
	try {
		await router.push(path)
		page = await mountComponent("../../src/masters/SupplierWarehouses.vue", { doc: supplier }, [router])
		assert.match(textContent(page.root), /No warehouses linked/)
		assert.equal(nodes(page.root, (node) => node.tag === "dialog").length, 0)
		await nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Create Warehouse")[0].props.onClick()
		await settle()
		const nameInput = () => nodes(page.root, (node) => node.props.id === "supplier-warehouse-name")[0]
		const submit = async () => { nodes(page.root, (node) => node.tag === "form")[0].props.onSubmit({ preventDefault() {} }); await settle(); await settle() }
		assert.equal(nameInput().props.value, "IE2 Knit Works")
		assert.equal(nodes(page.root, (node) => node.props.id === "supplier-warehouse-company")[0].props.disabled, true)
		await submit()
		nameInput().props.onInput({ target: { value: "  IE2 Dyeing Store " } })
		await settle()
		await submit()
		assert.deepEqual(insertions.map(({ warehouse_name, supplier, company, is_group }) => ({ warehouse_name, supplier, company, is_group })), [
			{ warehouse_name: "IE2 Knit Works", supplier: "IE2 Knit Works", company: "MGK", is_group: 0 },
			{ warehouse_name: "IE2 Dyeing Store", supplier: "IE2 Knit Works", company: "MGK", is_group: 0 },
		])
		assert.equal(router.currentRoute.value.fullPath, path)
		assert.equal(nodes(page.root, (node) => node.tag === "dialog").length, 1)
		assert.equal(nameInput().props.value, "")
		assert.deepEqual(toasts.map((toast) => [toast.severity, toast.summary]), [["success", "IE2 Knit Works - MGK created"], ["success", "IE2 Dyeing Store - MGK created"]])
		assert.match(textContent(page.root), /IE2 Knit Works ›/)
		assert.match(textContent(page.root), /IE2 Dyeing Store ›/)
		nameInput().props.onInput({ target: { value: "" } })
		await submit()
		assert.equal(insertions.length, 2)
		assert.match(textContent(page.root), /Missing required fields: Warehouse name/)
		nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Close")[0].props.onClick()
		await settle()
		assert.equal(nodes(page.root, (node) => node.tag === "dialog").length, 0)
	} finally {
		page?.close()
		bindToast(null)
		Object.assign(globalThis, { window: original.window, fetch: original.fetch })
		Object.assign(realtime, original.realtime)
		clearReadCaches()
	}
})
