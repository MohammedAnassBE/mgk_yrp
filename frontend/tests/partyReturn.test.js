import test from "node:test"
import assert from "node:assert/strict"
import { createRouter, createMemoryHistory } from "vue-router"
import { getMaster } from "../src/masters/mastersConfig.js"
import { partyReturnPath, safeReturnPath } from "../src/masters/masterFields.js"
import { readNewDefaults } from "../src/list/listState.js"
import { realtime } from "../src/realtime/socket.js"
import { clearReadCaches } from "../src/api/client.js"
import { FakeSocket } from "./helpers/fakeSocket.js"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"

function partyRouter() {
	return createRouter({ history: createMemoryHistory("/web/"), routes: [
		{ path: "/manage/:master/new", component: { render: () => null } },
		{ path: "/manage/:master/:name", component: { render: () => null } },
		{ path: "/:pathMatch(.*)*", component: { render: () => null } },
	] })
}

test("party return paths survive query serialization once, including spaces and reserved characters", () => {
	const router = partyRouter()
	for (const name of ["IE2 Knit Works", "AG/1", "A?#&+% Co", "Literal%20Name", "தமிழ் Supplier"]) {
		const target = router.resolve({ path: "/manage/addresses/new", query: { returnTo: partyReturnPath(getMaster("suppliers"), name) } })
		const query = router.resolve(target.fullPath).query
		const returned = router.resolve(safeReturnPath(query.returnTo))
		assert.equal(returned.params.name, name)
		assert.equal(returned.params.master, "suppliers")
		if (name === "IE2 Knit Works") assert.doesNotMatch(target.fullPath, /%2520/)
	}
})

test("Add address/contact saves linked defaults, returns to a spaced party name and lists the new record", async () => {
	const original = { window: globalThis.window, fetch: globalThis.fetch, realtime: { ...realtime } }
	const store = new Map()
	const permissions = Object.fromEntries(["read", "create", "write"].map((key) => [`can_${key}`, ["Supplier", "MGK Agent", "Warehouse", "Address", "Contact"]]))
	globalThis.window = { frappe: { boot: { defaults: { country: "India" }, user: { name: "Tester", ...permissions } } },
		addEventListener() {}, removeEventListener() {},
		sessionStorage: { getItem: (key) => store.get(key), setItem: (key, value) => store.set(key, value) } }
	Object.assign(realtime, { socket: null, pending: null, rooms: new Map(), reconnectHandlers: new Set(), stateHandlers: new Set(), factory: () => new FakeSocket() })
	const records = { Address: [], Contact: [] }
	const insertions = []
	const requests = []
	globalThis.fetch = async (url, options) => {
		requests.push(url)
		const parameters = new URL(url, "http://site").searchParams
		let response
		if (url.includes("getdoctype")) {
			const name = parameters.get("doctype")
			const fields = name === "Address" ? [
				{ fieldname: "country", label: "Country", fieldtype: "Link", options: "Country", reqd: 1 },
				{ fieldname: "address_type", label: "Address Type", fieldtype: "Select", reqd: 1, options: "Billing\nShipping" },
			] : []
			response = { docs: [{ name, fields }] }
		} else if (url.includes("get_list")) {
			const filters = JSON.parse(parameters.get("filters"))
			response = { message: records[parameters.get("doctype")].filter((record) => record.links.some((link) => link.link_doctype === filters[0][3] && link.link_name === filters[1][3])) }
		} else if (url.endsWith("frappe.client.insert")) {
			const doc = JSON.parse(options.body).doc
			insertions.push(doc)
			const title = doc.doctype === "Address" ? { address_title: "New Office" } : { full_name: "New Person" }
			const record = { ...doc, ...title, name: `New ${doc.doctype}`, __islocal: 0 }
			records[doc.doctype].push(record)
			response = { message: record }
		} else throw new Error(`Unexpected request: ${url}`)
		return { ok: true, status: 200, json: async () => structuredClone(response) }
	}
	let page
	try {
		const parties = {
			Supplier: { master: "suppliers", name: "IE2 Knit Works", supplier_name: "IE2 Knit Works" },
			"MGK Agent": { master: "agents", name: "Agent One", agent_name: "Agent One" },
			Warehouse: { master: "warehouses", name: "Dyeing Store - E", warehouse_name: "Dyeing Store" },
		}
		for (const partyType of Object.keys(parties)) for (const doctype of ["Address", "Contact"]) {
			const { master: key, ...fields } = parties[partyType]
			const name = fields.name
			const party = { doctype: partyType, ...fields }
			const master = getMaster(key)
			const router = partyRouter()
			await router.push(`${master.route}/${encodeURIComponent(name)}`)
			page = await mountComponent("../../src/masters/PartyAddresses.vue", { doc: party }, [router])
			const button = nodes(page.root, (node) => node.tag === "button" && textContent(node) === `Create ${doctype.toLowerCase()}`)[0]
			await button.props.onClick()
			assert.doesNotMatch(router.currentRoute.value.fullPath, /%2520/)
			const draft = readNewDefaults(router.currentRoute.value.query.defaults, doctype)
			assert.deepEqual(draft.defaults.links, [{ doctype: "Dynamic Link", link_doctype: partyType, link_name: name }])
			assert.equal(draft.defaults.address_title, doctype === "Address" ? fields.warehouse_name || name : undefined)
			const newPath = router.currentRoute.value.fullPath
			page.close()
			await router.push(newPath)
			page = await mountComponent("../../src/masters/MasterEntry.vue", { master: getMaster(doctype === "Address" ? "addresses" : "contacts") }, [router])
			await nodes(page.root, (node) => node.tag === "button" && textContent(node) === "Save")[0].props.onClick()
			assert.equal(router.currentRoute.value.params.name, name)
			assert.equal(router.currentRoute.value.params.master, master.key)
			assert.deepEqual(insertions.at(-1).links, draft.defaults.links)
			if (doctype === "Address") {
				assert.equal(insertions.at(-1).country, "India")
				assert.equal(insertions.at(-1).address_type, "Billing")
			}
			const partyPath = router.currentRoute.value.fullPath
			page.close()
			await router.push(partyPath)
			const reads = requests.length
			page = await mountComponent("../../src/masters/PartyAddresses.vue", { doc: party }, [router])
			await settle()
			assert.ok(requests.slice(reads).some((url) => url.includes("get_list")))
			assert.match(textContent(page.root), doctype === "Address" ? /New Office/ : /New Person/)
			page.close(); page = null
		}
	} finally {
		page?.close()
		Object.assign(globalThis, { window: original.window, fetch: original.fetch })
		Object.assign(realtime, original.realtime)
		clearReadCaches()
	}
})
