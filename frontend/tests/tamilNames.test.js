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
	assert.deepEqual(TAMIL_NAME_DOCTYPES, ["Item", "Supplier", "Warehouse", "MGK Agent"])
	for (const key of ["items", "suppliers", "warehouses", "agents"]) {
		const master = getMaster(key)
		assert.ok(hasTamilName(master.doctype))
		assert.ok(master.formOrder.includes("mgk_tamil_name"), key)
		assert.ok(master.formGroups[0].fields.includes("mgk_tamil_name"), key)
	}
	assert.equal(hasTamilName("Address"), false)
})

test("English mode leaves Link suggestions untouched and makes no extra request", async () => {
	setLanguage("en")
	const calls = []
	const restore = stubFetch(calls)
	try {
		const options = [{ value: "SUP-1" }]
		assert.equal(await withTamilNames("Supplier", options), options)
		assert.equal(calls.length, 0)
	} finally { restore() }
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
