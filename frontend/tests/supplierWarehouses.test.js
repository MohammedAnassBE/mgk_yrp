import test from "node:test"
import assert from "node:assert/strict"
import { createRouter, createMemoryHistory } from "vue-router"
import { getMaster } from "../src/masters/mastersConfig.js"
import { supplierWarehouseDraft } from "../src/masters/masterFields.js"
import { readNewDefaults } from "../src/list/listState.js"
import { realtime } from "../src/realtime/socket.js"
import { clearReadCaches } from "../src/api/client.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

test("supplier warehouse draft prefills supplier, name and the only company", () => {
	const supplier = { name: "SUP-1", supplier_name: "IE2 Knit Works" }
	assert.deepEqual(supplierWarehouseDraft(supplier, [{ name: "MGK" }]), { supplier: "SUP-1", warehouse_name: "IE2 Knit Works", is_group: 0, company: "MGK" })
	assert.equal(supplierWarehouseDraft(supplier, [{ name: "A" }, { name: "B" }]).company, undefined)
})

test("Create Warehouse opens a prefilled warehouse, saves it and returns to the supplier list", async () => {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	const store = new Map()
	const permissions = Object.fromEntries(["read", "create", "write"].map((key) => [`can_${key}`, ["Supplier", "Warehouse", "Company"]]))
	globalThis.window = { frappe: { boot: { user: { name: "Tester", ...permissions } } }, addEventListener() {}, removeEventListener() {},
		sessionStorage: { getItem: (key) => store.get(key), setItem: (key, value) => store.set(key, value) } }
	Object.assign(realtime, { socket: null, pending: null, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	const warehouses = []
	const insertions = []
	globalThis.fetch = async (url, options) => {
		const parameters = new URL(url, "http://site").searchParams
		let response
		if (url.includes("getdoctype")) {
			response = { docs: [{ name: "Warehouse", fields: ["warehouse_name", "supplier", "company", "is_group"].map((fieldname) => ({ fieldname, label: fieldname, fieldtype: "Data" })) }] }
		} else if (url.includes("get_list") && parameters.get("doctype") === "Company") response = { message: [{ name: "MGK" }] }
		else if (url.includes("get_list")) {
			const filters = JSON.parse(parameters.get("filters"))
			response = { message: warehouses.filter((row) => row.supplier === filters.supplier) }
		} else if (url.endsWith("frappe.client.insert")) {
			const doc = JSON.parse(options.body).doc
			insertions.push(doc)
			const record = { ...doc, name: `${doc.warehouse_name} - MGK`, __islocal: 0 }
			warehouses.push(record)
			response = { message: record }
		} else throw new Error(`Unexpected request: ${url}`)
		return { ok: true, status: 200, json: async () => structuredClone(response) }
	}
	const router = createRouter({ history: createMemoryHistory("/web/"), routes: [
		{ path: "/manage/:master/new", component: { render: () => null } },
		{ path: "/manage/:master/:name", component: { render: () => null } },
	] })
	const supplier = { doctype: "Supplier", name: "IE2 Knit Works", supplier_name: "IE2 Knit Works" }
	let page
	try {
		await router.push(`/manage/suppliers/${encodeURIComponent(supplier.name)}`)
		page = await mountComponent("../../src/masters/SupplierWarehouses.vue", { doc: supplier }, [router])
		await settle()
		assert.match(textContent(page.root), /No warehouses linked/)
		await nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Create Warehouse")[0].props.onClick()
		assert.equal(router.currentRoute.value.path, "/manage/warehouses/new")
		const draft = readNewDefaults(router.currentRoute.value.query.defaults, "Warehouse")
		assert.deepEqual(draft.defaults, { supplier: "IE2 Knit Works", warehouse_name: "IE2 Knit Works", is_group: 0, company: "MGK" })
		const newPath = router.currentRoute.value.fullPath
		page.close()
		await router.push(newPath)
		page = await mountComponent("../../src/masters/MasterEntry.vue", { master: getMaster("warehouses") }, [router])
		await nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Save")[0].props.onClick()
		assert.equal(insertions[0].supplier, "IE2 Knit Works")
		assert.equal(insertions[0].company, "MGK")
		assert.equal(router.currentRoute.value.params.master, "suppliers")
		assert.equal(router.currentRoute.value.params.name, "IE2 Knit Works")
		page.close()
		page = await mountComponent("../../src/masters/SupplierWarehouses.vue", { doc: supplier }, [router])
		await settle()
		assert.match(textContent(page.root), /IE2 Knit Works ›/)
		page.close(); page = null
	} finally {
		page?.close()
		Object.assign(globalThis, { window: original.window, fetch: original.fetch })
		Object.assign(realtime, original.realtime)
		clearReadCaches()
	}
})
