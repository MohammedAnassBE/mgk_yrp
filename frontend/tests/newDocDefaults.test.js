import test from "node:test"
import assert from "node:assert/strict"
import { metaDefaults } from "../src/document/newDocDefaults.js"

const now = new Date(2026, 9, 29, 9, 8, 7)
const link = (fieldname, options, extra = {}) => ({ fieldname, fieldtype: "Link", options, ...extra })
function defaults(fields, boot = {}, extra = {}) {
	return metaDefaults({ name: "Warehouse", fields, ...extra }, now, boot)
}

test("field defaults win over user/global defaults and keep numeric zero and table types", () => {
	const record = defaults([link("company", "Company", { default: "Field Company" }),
		{ fieldname: "enabled", fieldtype: "Check", default: "0" },
		{ fieldname: "rate", fieldtype: "Currency", default: "12.5" },
		{ fieldname: "items", fieldtype: "Table" }, { fieldname: "links", fieldtype: "Table MultiSelect" },
	], { defaults: { company: "Global Company" }, user: { defaults: { company: "User Company" } } })
	assert.equal(record.company, "Field Company")
	assert.equal(record.enabled, 0)
	assert.equal(record.rate, 12.5)
	assert.deepEqual(record.items, [])
	assert.deepEqual(record.links, [])
})

test("Today, now, __user, user and user_fullname resolve from the current session", () => {
	const record = defaults([
		{ fieldname: "date", fieldtype: "Date", default: "Today" },
		{ fieldname: "time", fieldtype: "Time", default: "nOw" },
		...(["__user", "User", "user_fullname"].map((value, index) => ({ fieldname: `user${index}`, fieldtype: "Data", default: value }))),
	], { user: { name: "user@example.test", first_name: "Test", last_name: "User" } })
	assert.equal(record.date, "2026-10-29")
	assert.equal(record.time, "09:08:07")
	assert.equal(record.user0, "user@example.test")
	assert.equal(record.user1, "user@example.test")
	assert.equal(record.user2, "Test User")
})

test("Datetime now uses the system timezone", () => {
	const record = metaDefaults({ name: "Log", fields: [{ fieldname: "timestamp", fieldtype: "Datetime", default: "now" }] },
		new Date("2026-10-29T23:00:00Z"), { sysdefaults: { time_zone: "Asia/Kolkata" } })
	assert.equal(record.timestamp, "2026-10-30 04:30:00")
})

test("Warehouse Company and Address Country use merged session defaults and user overrides", () => {
	const boot = { sysdefaults: { currency: "INR" }, defaults: { company: "Essdee India", country: "India" },
		user: { defaults: { country: "Nepal" } } }
	assert.equal(defaults([link("company", "Company")], boot).company, "Essdee India")
	const address = metaDefaults({ name: "Address", fields: [link("country", "Country"),
		{ fieldname: "address_type", fieldtype: "Select", reqd: 1, options: "Billing\nShipping\nOffice" },
	] }, now, boot)
	assert.equal(address.country, "Nepal")
	assert.equal(address.address_type, "Billing")
	assert.equal(defaults([link("currency", "Currency")], boot).currency, "INR")
})

test("Link defaults resolve both field names and exact or scrubbed Link doctypes", () => {
	const fields = [link("billing_company", "Company"), link("other_country", "Country"), link("price_currency", "Currency")]
	const record = defaults(fields, { defaults: { company: "Essdee India", Country: ["India"], price_currency: "INR" } })
	assert.equal(record.billing_company, "Essdee India")
	assert.equal(record.other_country, "India")
	assert.equal(record.price_currency, "INR")
	assert.equal(defaults([link("billing_company", "Company")], { defaults: { Company: ["One", "Two"] } }).billing_company, undefined)
})

test("single and marked-default Link permissions apply only to their parent doctype", () => {
	const boot = { defaults: { company: "Global" }, user: { user_permissions: { Company: [
		{ doc: "Allowed", applicable_for: "Warehouse" }, { doc: "Elsewhere", applicable_for: "Invoice", is_default: 1 },
	] } } }
	assert.equal(defaults([link("company", "Company")], boot).company, "Allowed")
	boot.user.user_permissions.Company.push({ doc: "Preferred", is_default: 1 })
	assert.equal(defaults([link("company", "Company")], boot).company, "Preferred")
})

test("Link defaults outside applicable permissions are rejected, including explicit defaults", () => {
	const boot = { defaults: { company: "Forbidden" }, user: { user_permissions: { Company: [{ doc: "One" }, { doc: "Two" }] } } }
	assert.equal(defaults([link("company", "Company", { default: "Forbidden" })], boot).company, undefined)
	boot.defaults.company = "Two"
	assert.equal(defaults([link("company", "Company", { default: "Forbidden" })], boot).company, "Two")
	assert.equal(defaults([link("company", "Company", { default: "One" })], boot).company, "One")
})

test("User links, readonly links and ignored permissions follow Desk exclusions", () => {
	const boot = { defaults: { company: "Global", user: "Tester", Company: "Other" }, user: { user_permissions: {
		Company: [{ doc: "Allowed" }], User: [{ doc: "Tester" }],
	} } }
	assert.equal(defaults([link("company", "Company", { ignore_user_permissions: 1 })], boot).company, "Global")
	assert.equal(defaults([link("company", "Company", { read_only: 1 })], boot).company, undefined)
	assert.equal(defaults([link("user", "User")], boot).user, undefined)
	assert.equal(defaults([link("company", "Company", { read_only: 1, default: "Allowed" })], boot).company, "Allowed")
})

test("Select first option preserves a leading blank and skips placeholder options", () => {
	for (const reqd of [0, 1]) {
		assert.equal(defaults([{ fieldname: "type", fieldtype: "Select", reqd, options: "Billing\nShipping" }]).type, "Billing")
		assert.equal(defaults([{ fieldname: "type", fieldtype: "Select", reqd, options: "\nBilling\nShipping" }]).type, "")
	}
	assert.equal(defaults([{ fieldname: "type", fieldtype: "Select", options: "Billing\nShipping", default: "Shipping" }]).type, "Shipping")
	for (const options of ["[Select]", "Loading..."]) assert.equal(defaults([{ fieldname: "type", fieldtype: "Select", options }]).type, undefined)
})

test("no_default, layout fields and literal title defaults are skipped", () => {
	const record = defaults([link("company", "Company", { default: "Hidden", no_default: 1 }),
		{ fieldname: "section", fieldtype: "Section Break", default: "Ignored" },
		{ fieldname: "title", fieldtype: "Data", default: "Do not copy" },
	], {}, { title_field: "title" })
	assert.deepEqual(record, { doctype: "Warehouse", docstatus: 0, __islocal: 1 })
})
