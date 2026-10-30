import test from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"

async function desk(doctype, initial, count = 1) {
	const handlers = {}, queries = {}, calls = []
	const form = { doc: { docstatus: 0, ...initial }, is_new: () => true,
		set_query: (name, query) => { queries[name] = query },
		async set_value(name, value) {
			const values = typeof name === "string" ? { [name]: value } : name
			const changed = Object.keys(values).filter((key) => this.doc[key] !== values[key])
			Object.assign(this.doc, values)
			for (const key of changed) await handlers[doctype][key]?.(form)
		}, clear_table: (name) => { form.doc[name] = [] }, refresh_field: () => {} }
	const frappe = { ui: { form: { on: (name, events) => { handlers[name] = events } } },
		call: async ({ method, args }) => {
			calls.push({ method, args })
			if (method.endsWith("get_own_location")) return { message: { location: "Own", warehouse: "Own-W", warehouses: ["Own-W"] } }
			if (method.endsWith("get_party_defaults")) return { message: {
				warehouses: count === 1 ? [`${args.supplier}-W`] : ["W1", "W2"], warehouse: count === 1 ? `${args.supplier}-W` : null,
				address: "A1", contact: "C1",
			} }
			if (method.endsWith("get_address_display")) return { message: "Main Road" }
			if (method.endsWith("get_contact_details")) return { message: { contact_display: "Asha", contact_mobile: "123" } }
			assert.fail(`Unexpected method ${method}`)
		} }
	const slug = doctype.toLowerCase().replaceAll(" ", "_")
	const source = await readFile(new URL(`../../mgk_yrp/mgk_yrp/doctype/${slug}/${slug}.js`, import.meta.url), "utf8")
	vm.runInNewContext(source, { frappe })
	assert.equal(source.includes('get_list("Warehouse"'), false)
	await handlers[doctype].setup(form)
	return { form, queries, calls, events: handlers[doctype] }
}

test("Desk PO/DC new docs default MGK Location and use the shared party API for unique warehouses", async () => {
	for (const [doctype, location, warehouse] of [["MGK Purchase Order", "delivery_location", "warehouse"], ["MGK Delivery Challan", "from_location", "from_warehouse"]]) {
		const page = await desk(doctype, {})
		await page.events.onload(page.form)
		assert.equal(page.form.doc[location], "Own")
		assert.equal(page.form.doc[warehouse], "Own-W")
		page.form.doc[location] = "Worker"
		await page.events[location](page.form)
		assert.equal(page.form.doc[warehouse], "Worker-W")
		assert.equal(page.calls.some((call) => call.method === "mgk_yrp.party_defaults.get_party_defaults"), true)
		assert.deepEqual(JSON.parse(JSON.stringify(page.queries[warehouse]().filters)), { supplier: "Worker", disabled: 0, is_group: 0 })
	}
})

test("Desk two-warehouse parties clear the old warehouse and filter the picker to that party", async () => {
	for (const [doctype, location, warehouse] of [["MGK Purchase Order", "delivery_location", "warehouse"],
		["MGK Goods Received Note", "delivery_location", "warehouse"], ["MGK Delivery Challan", "to_location", "to_warehouse"]]) {
		const page = await desk(doctype, { [location]: "Worker", [warehouse]: "Old" }, 2)
		await page.events[location](page.form)
		assert.equal(page.form.doc[warehouse], null)
		assert.deepEqual(JSON.parse(JSON.stringify(page.queries[warehouse]().filters)), { supplier: "Worker", disabled: 0, is_group: 0 })
	}
})

test("Desk PO supplier uses shared preferred address/contact defaults and companion display calls", async () => {
	const page = await desk("MGK Purchase Order", { supplier: "Worker" })
	await page.events.supplier(page.form)
	assert.equal(page.form.doc.supplier_address, "A1")
	assert.equal(page.form.doc.contact_person, "C1")
	assert.equal(page.form.doc.address_display, "Main Road")
	assert.equal(page.form.doc.contact_display, "Asha")
	assert.equal(page.calls.filter((call) => call.method.includes("get_party_defaults")).length, 1)
})

test("Desk GRN defaults its receiving warehouse from own location, and mapped PO/return headers are preserved", async () => {
	const grn = await desk("MGK Goods Received Note", {})
	await grn.events.onload(grn.form)
	assert.equal(grn.form.doc.warehouse, "Own-W")
	assert.deepEqual(JSON.parse(JSON.stringify(grn.queries.warehouse().filters)), { supplier: "Own", disabled: 0, is_group: 0 })
	const mapped = await desk("MGK Goods Received Note", { against_purchase_order: 1, warehouse: "PO-W" })
	await mapped.events.onload(mapped.form)
	assert.equal(mapped.calls.length, 0)
	assert.equal(mapped.form.doc.warehouse, "PO-W")
	const returned = await desk("MGK Delivery Challan", { is_return: 1, from_location: "Worker", from_warehouse: "Source-W" })
	await returned.events.onload(returned.form)
	await returned.events.from_location(returned.form)
	assert.equal(returned.calls.length, 0)
	assert.equal(returned.form.doc.from_warehouse, "Source-W")
})
