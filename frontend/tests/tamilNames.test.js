import test from "node:test"
import assert from "node:assert/strict"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { clearReadCaches } from "../src/api/client.js"
import { getMaster } from "../src/masters/mastersConfig.js"
import { language, setLanguage, hasTamilName, withTamilNames, TAMIL_NAME_DOCTYPES } from "../src/shell/displayLanguage.js"

const inputs = (root) => nodes(root, (node) => node.tag === "input")
const tamilRows = { "SUP-1": "முருகன் மில்ஸ்", "SUP-2": "" }

function stubFetch(calls) {
	const original = globalThis.fetch
	globalThis.fetch = async (url) => {
		const text = decodeURIComponent(String(url))
		calls.push(text)
		let message = []
		if (text.includes("getdoctype")) return { ok: true, status: 200, json: async () => ({ docs: [{ name: new URL(String(url), "http://x").searchParams.get("doctype"), title_field: "supplier_name", show_title_field_in_link: 1 }] }) }
		if (text.includes("frappe.client.get_list")) message = Object.entries(tamilRows).map(([name, mgk_tamil_name]) => ({ name, mgk_tamil_name }))
		if (text.includes("frappe.client.get_value")) message = { supplier_name: "Murugan Mills", ...(text.includes("mgk_tamil_name") ? { mgk_tamil_name: tamilRows["SUP-1"] } : {}) }
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	return () => { globalThis.fetch = original; clearReadCaches() }
}

test("Tamil name masters match the reference app and every master form lists the field", () => {
	assert.deepEqual(TAMIL_NAME_DOCTYPES, ["Item", "Supplier", "Warehouse", "MGK Agent", "YRP Process", "Item Group"])
	for (const key of ["items", "suppliers", "warehouses", "agents", "processes"]) {
		const master = getMaster(key)
		assert.ok(hasTamilName(master.doctype))
		assert.ok(master.formOrder.includes("mgk_tamil_name"), key)
		assert.ok(master.formGroups[0].fields.includes("mgk_tamil_name"), key)
	}
	assert.equal(hasTamilName("Address"), false)
})

test("English mode shows the Tamil name under the English one and finds records by typed Tamil text", async () => {
	setLanguage("en")
	const calls = []
	const restore = stubFetch(calls)
	const page = await mountComponent("../../src/document/fields/LinkField.vue", { doctype: "Supplier", candidates: [{ value: "SUP-1" }, { value: "SUP-2" }] })
	try {
		inputs(page.root)[0].props.onInput({ target: { value: "முருகன்" } })
		await new Promise((resolve) => setTimeout(resolve, 250))
		await settle()
		const rows = nodes(page.root, (node) => node.tag === "li")
		assert.equal(rows.length, 1, "typed Tamil text matches the Tamil name")
		assert.equal(textContent(nodes(rows[0], (node) => node.tag === "strong")[0]), "SUP-1")
		assert.deepEqual(nodes(rows[0], (node) => node.tag === "small").map(textContent), [tamilRows["SUP-1"]])
		assert.equal(await withTamilNames("Address", [{ value: "A-1" }]).then((rows) => rows[0].tamil), undefined)
		assert.ok(!calls.some((url) => url.includes("Address")))
	} finally { page.close(); restore() }
})

test("filter Link input lists both language names in each suggestion", async () => {
	setLanguage("en")
	const original = globalThis.fetch
	globalThis.fetch = async (url) => {
		const text = decodeURIComponent(String(url))
		const message = text.includes("search_link") ? [{ value: "SUP-1", description: `Raw Material, ${tamilRows["SUP-1"]}` }]
			: text.includes("frappe.client.get_list") ? [{ name: "SUP-1", mgk_tamil_name: tamilRows["SUP-1"] }] : []
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	const page = await mountComponent("../../src/list/LinkInput.vue", { doctype: "Supplier" })
	try {
		await inputs(page.root)[0].props.onFocus()
		await settle()
		const row = nodes(page.root, (node) => node.tag === "li")[0]
		assert.equal(textContent(nodes(row, (node) => node.tag === "strong")[0]), "SUP-1")
		assert.deepEqual(nodes(row, (node) => node.tag === "small").map(textContent), [tamilRows["SUP-1"], "Raw Material"])
	} finally { page.close(); globalThis.fetch = original; clearReadCaches() }
})

test("suggestion rows put the current language first and treat a typed Tamil name as an exact match", async () => {
	const { linkRow } = await import("../src/list/linkOptions.js")
	const { hasExactMatch } = await import("../src/document/fields/quickCreate.js")
	const option = { value: "AG-1", label: "Buying Supplier", tamil: "வாங்கும் சப்ளையர்", description: "AG-1, வாங்கும் சப்ளையர்" }
	assert.deepEqual(linkRow(option, false), { primary: "Buying Supplier", secondary: ["வாங்கும் சப்ளையர்", "AG-1"] })
	assert.deepEqual(linkRow(option, true), { primary: "வாங்கும் சப்ளையர்", secondary: ["Buying Supplier", "AG-1"] })
	assert.deepEqual(linkRow({ value: "Address 1" }, true), { primary: "Address 1", secondary: [] })
	assert.equal(hasExactMatch([option], " வாங்கும் சப்ளையர் "), true)
	assert.equal(hasExactMatch([option], "buying supplier"), true)
})

test("Tamil mode labels suggestions and the selected value in Tamil while storing the record name", async () => {
	const calls = []
	const restore = stubFetch(calls)
	setLanguage("ta")
	const page = await mountComponent("../../src/document/fields/LinkField.vue", { doctype: "Supplier", modelValue: "SUP-1",
		candidates: [{ value: "SUP-1" }, { value: "SUP-2" }] })
	try {
		await settle(); await settle()
		assert.equal(inputs(page.root)[0].props.value, tamilRows["SUP-1"])
		await inputs(page.root)[0].props.onFocus()
		await settle()
		const options = nodes(page.root, (node) => node.tag === "li")
		assert.equal(options.length, 1, "focus searches by the stored value, not the Tamil label")
		assert.equal(textContent(options[0]), `${tamilRows["SUP-1"]}SUP-1`)
		inputs(page.root)[0].props.onInput({ target: { value: "SUP" } })
		await new Promise((resolve) => setTimeout(resolve, 250))
		await settle()
		const typed = nodes(page.root, (node) => node.tag === "li")
		assert.deepEqual(typed.map(textContent), [`${tamilRows["SUP-1"]}SUP-1`, "SUP-2"])
		assert.ok(calls.some((url) => url.includes("frappe.client.get_list") && url.includes("mgk_tamil_name")))
	} finally {
		page.close()
		setLanguage("en")
		restore()
	}
	assert.equal(language.value, "en")
})

test("Tamil mode falls back to the English title for records without a Tamil name", async () => {
	const calls = []
	const restore = stubFetch(calls)
	setLanguage("ta")
	const page = await mountComponent("../../src/document/fields/LinkField.vue", { doctype: "Address", modelValue: "SUP-1", candidates: [] })
	try {
		await settle(); await settle()
		assert.equal(inputs(page.root)[0].props.value, "Murugan Mills")
		assert.ok(!calls.some((url) => url.includes("mgk_tamil_name")))
	} finally {
		page.close()
		setLanguage("en")
		restore()
	}
})

test("Process and Item Group names switch to Tamil in facts, list fields and PO tabs", async () => {
	const { displayName, fieldDisplayName, tabLabel, tamilNamesSettled } = await import("../src/shell/displayLanguage.js")
	const { orderedTabs } = await import("../src/list/listQuery.js")
	const { default: purchaseOrderBook } = await import("../src/books/purchase-order/config.js")
	const deliveryChallan = await import("../src/documents/delivery-challan/presentation.js")
	const purchaseOrder = await import("../src/documents/purchase-order/presentation.js")
	const rows = { "YRP Process": [{ name: "Dyeing", mgk_tamil_name: "சாயம்", process_name: "Dyeing" }],
		"Item Group": [{ name: "Karigan Items", mgk_tamil_name: "காரிகான் பொருட்கள்", item_group_name: "Karigan Items" },
			{ name: "Salavai Cone Items", mgk_tamil_name: "", item_group_name: "Salavai Cone Items" }] }
	const original = globalThis.fetch
	globalThis.fetch = async (url) => {
		const params = new URL(String(url), "http://x").searchParams
		const names = JSON.parse(params.get("filters") || "[[0,0,[]]]")[0][2]
		const message = (rows[params.get("doctype")] || []).filter((row) => names.includes(row.name))
		return { ok: true, status: 200, json: async () => ({ message }) }
	}
	const tabs = () => orderedTabs(purchaseOrderBook.tabs).map(tabLabel)
	const doc = { process_name: "Dyeing", item_group: "Karigan Items", items: [] }
	try {
		setLanguage("ta")
		tabs(); displayName("YRP Process", "Dyeing")
		await tamilNamesSettled()
		assert.equal(displayName("YRP Process", "Dyeing"), "சாயம்")
		assert.equal(fieldDisplayName("process_name", "Dyeing"), "சாயம்")
		assert.equal(fieldDisplayName("item_group", "Karigan Items"), "காரிகான் பொருட்கள்")
		assert.equal(deliveryChallan.summary(doc).lines.find((line) => line.label === "Process").value, "சாயம்")
		assert.equal(purchaseOrder.viewFacts(doc).find((fact) => fact.label === "Item group").value, "காரிகான் பொருட்கள்")
		assert.deepEqual(tabs(), ["அனைத்தும்", "காரிகான் பொருட்கள்", "சலவைக்கோன்"], "Item Group Tamil name, else the tab's Tamil text")
		setLanguage("en")
		assert.deepEqual(tabs(), ["All", "Karigan", "Salavai Cone"])
		assert.equal(displayName("YRP Process", "Dyeing"), "Dyeing")
	} finally { globalThis.fetch = original; clearReadCaches(); setLanguage("en") }
})
