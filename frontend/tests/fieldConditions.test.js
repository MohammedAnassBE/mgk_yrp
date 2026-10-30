import test from "node:test"
import assert from "node:assert/strict"
import { condition, fieldState, missingFields } from "../src/document/fieldConditions.js"
const user = { name: "stock@example.test", roles: ["Stock User"] }
const meta = { permissions: [{ role: "Stock User", permlevel: 0, read: 1, write: 1 }, { role: "Stock User", permlevel: 1, read: 1 }] }

test("depends_on, read_only_depends_on and mandatory_depends_on support eval and plain field names", () => {
	const field = { fieldname: "purchase_order", fieldtype: "Link", depends_on: "eval:doc.against_purchase_order", mandatory_depends_on: "against_purchase_order", read_only_depends_on: "eval:!doc.edit_posting_date_and_time" }
	assert.deepEqual(fieldState(field, { against_purchase_order: 0 }, meta, user), { visible: false, readOnly: true, required: false })
	assert.deepEqual(fieldState(field, { against_purchase_order: 1, edit_posting_date_and_time: 1 }, meta, user), { visible: true, readOnly: false, required: true })
	assert.equal(condition('eval:doc.goods_routing == "Through Vendor"', { goods_routing: "Through Vendor" }), true)
	assert.equal(condition("supplier", { supplier: "Party" }), true)
	assert.equal(condition("items", { items: [] }), false)
	assert.equal(condition("items", { items: [{ qty: 1 }] }), true)
})

test("Warehouse depends_on accepts Desk's trailing semicolon and whitespace on new and saved docs", () => {
	for (const name of [undefined, "Stores - MGK"]) {
		assert.equal(condition("eval:(!doc.is_group);", { name, is_group: 0 }), true)
		assert.equal(condition("  eval:(!doc.is_group); ; \n", { name, is_group: 1 }), false)
	}
})

test("User condition exposes in_list for System and Website users, enabled or disabled", () => {
	const expression = "eval:in_list(['System User', 'Website User'], doc.user_type) && doc.enabled == 1"
	for (const user_type of ["System User", "Website User"]) {
		assert.equal(condition(expression, { user_type, enabled: 1 }), true)
		assert.equal(condition(expression, { user_type, enabled: 0 }), false)
	}
	assert.equal(condition(expression, { user_type: "Other", enabled: 1 }), false)
})

test("Desk scalar helpers, parent and boot user context are available to metadata expressions", () => {
	const doc = { qty: "0002.8", amount: "₹ 1,200.50", empty: "  ", enabled: 1 }
	const options = { parent: { approved: 1 }, boot: { user: { name: "manager@example.test", roles: ["Stock Manager"] } } }
	for (const expression of [
		"cint(doc.qty) === 2", "cint(true) === 1 && cint(false) === 0", "cint('bad', 7) === 7",
		"flt(doc.amount) === 1200.5", "flt('invalid') === 0", "flt(null) === 0",
		"flt('1.234', 2) === 1.23", "flt('1.200,50', 2, '#.###,##') === 1200.5",
		"flt('1 200,50', 2, '# ###,##') === 1200.5", "flt('1,200') === 1200",
		"flt('1.200', null, '#.###') === 1200", "flt('1,200', null, '#,###') === 1200",
		"cstr(null) === '' && cstr(0) === '0'", "is_null(doc.empty) && !is_null(0)",
		"parent.approved === 1 && doc.enabled === 1", "in_list(frappe.user_roles, 'Stock Manager')",
		"frappe.session.user === 'manager@example.test'",
	]) assert.equal(condition(`eval:${expression};`, doc, options), true, expression)
	assert.equal(condition("eval:parent === doc", doc), true)
	assert.equal(condition((doc) => doc.enabled === 1, doc), true)
	assert.equal(condition(true, doc), true)
	assert.equal(condition(false, doc), false)
	assert.equal(condition("supplier", null), false)
	assert.equal(condition(" supplier; ", { supplier: "Vendor" }), true)
})

test("flt uses Desk's legacy, banker and commercial rounding from boot", () => {
	for (const [method, expected] of [["Banker's Rounding (legacy)", [2, 1.01]], ["Banker's Rounding", [2, 1]], ["Commercial Rounding", [3, 1.01]]]) {
		const options = { boot: { sysdefaults: { rounding_method: method } } }
		assert.equal(condition("eval:flt(2.5, 0) === doc.whole && flt(1.005, 2) === doc.cents", { whole: expected[0], cents: expected[1] }, options), true, method)
		assert.equal(condition("eval:flt(-2.5, 0) === -doc.whole && flt(-1.005, 2) === -doc.cents", { whole: expected[0], cents: expected[1] }, options), true, method)
	}
	assert.equal(condition("eval:flt(doc.amount) === 1200.5", { amount: "1.200,50" }, { boot: { sysdefaults: { number_format: "#.###,##" } } }), true)
})

test("condition context reads the current boot on every evaluation without mutating frappe", () => {
	const original = globalThis.window
	const frappe = { boot: { user: { name: "one", roles: ["Stock User"] } } }
	globalThis.window = { frappe }
	try {
		assert.equal(condition("eval:frappe.session.user === 'one' && in_list(frappe.user_roles, 'Stock User')", {}), true)
		frappe.boot = { user: { name: "two" }, roles: ["Accounts User"] }
		assert.equal(condition("eval:frappe.session.user === 'two' && in_list(frappe.user_roles, 'Accounts User')", {}), true)
		assert.equal(frappe.session, undefined)
		assert.equal(frappe.user_roles, undefined)
	} finally { globalThis.window = original }
})

test("unrecognised conditions log once per doctype, field and expression and fail closed without crashing", (t) => {
	const logger = t.mock.method(console, "error", () => {})
	const broken = "eval:unknown_helper(doc.value)"
	const field = { fieldname: "broken", fieldtype: "Data", depends_on: broken, mandatory_depends_on: broken, read_only_depends_on: broken }
	const metadata = { ...meta, name: "Warehouse" }
	for (let index = 0; index < 3; index++) {
		assert.deepEqual(fieldState(field, {}, metadata, user), { visible: false, required: false, readOnly: false })
		assert.equal(fieldState({ ...field, fieldname: "working", depends_on: null, mandatory_depends_on: null, read_only_depends_on: null }, {}, metadata, user).visible, true)
	}
	assert.equal(logger.mock.callCount(), 1)
	assert.match(logger.mock.calls[0].arguments[0], /Warehouse\.broken: eval:unknown_helper/)
	assert.ok(logger.mock.calls[0].arguments[1] instanceof ReferenceError)
	assert.equal(condition("eval:doc.", {}, { doctype: "User", fieldname: "syntax" }), false)
	assert.equal(logger.mock.callCount(), 2)
	fieldState({ ...field, fieldname: "another" }, {}, metadata, user)
	fieldState(field, {}, { ...metadata, name: "Supplier" }, user)
	assert.equal(logger.mock.callCount(), 4)
})

test("child field visibility, mandatory and read-only conditions evaluate against their real parent", () => {
	const field = { fieldname: "qty", fieldtype: "Float", depends_on: "eval:parent.enabled",
		mandatory_depends_on: "eval:parent.required", read_only_depends_on: "eval:parent.locked" }
	assert.deepEqual(fieldState(field, { qty: 1 }, meta, user, { enabled: 1, required: 1, locked: 1 }), { visible: true, required: true, readOnly: true })
	assert.deepEqual(fieldState(field, { qty: 1 }, meta, user, { enabled: 0 }), { visible: false, required: false, readOnly: false })
})

test("permlevels, hidden controls, submitted allow_on_submit and cancellation lock", () => {
	const field = { fieldname: "private", fieldtype: "Data", permlevel: 1 }
	assert.equal(fieldState(field, {}, meta, user).readOnly, true)
	assert.equal(fieldState({ ...field, permlevel: 2 }, {}, meta, user).visible, false)
	assert.equal(fieldState({ ...field, hidden: 1 }, {}, meta, user).visible, false)
	assert.equal(fieldState({ ...field, permlevel: 0 }, { docstatus: 1 }, meta, user).readOnly, true)
	assert.equal(fieldState({ ...field, permlevel: 0, allow_on_submit: 1 }, { docstatus: 1 }, meta, user).readOnly, false)
	assert.equal(fieldState({ ...field, permlevel: 0, allow_on_submit: 1 }, { docstatus: 2 }, meta, user).readOnly, true)
})

test("DetailsPanel missing computation names only visible required fields, including readonly auto fields", () => {
	const fields = [
		{ fieldname: "warehouse", label: "Warehouse", fieldtype: "Link", reqd: 1, read_only: 1 },
		{ fieldname: "handling_supplier", label: "Handling Supplier", fieldtype: "Link", depends_on: 'eval:doc.goods_routing === "Through Vendor"', mandatory_depends_on: 'eval:doc.goods_routing === "Through Vendor"' },
		{ fieldname: "items", label: "Items", fieldtype: "Table", reqd: 1 },
		{ fieldname: "amount", label: "Amount", fieldtype: "Currency", reqd: 1 },
	]
	const doc = { goods_routing: "Direct", items: [], amount: 0 }
	assert.deepEqual(missingFields(fields, doc, meta, user).map((field) => field.label), ["Warehouse", "Items"])
	doc.goods_routing = "Through Vendor"
	doc.items.push({ qty: 1 })
	assert.deepEqual(missingFields(fields, doc, meta, user).map((field) => field.label), ["Warehouse", "Handling Supplier"])
})
