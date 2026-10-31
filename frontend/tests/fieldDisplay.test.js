import test from "node:test"
import assert from "node:assert/strict"
import { formatFieldValue } from "../src/document/fieldDisplay.js"
import { mountComponent, textContent } from "./helpers/component.js"

test("Time display keeps HH:MM:SS and removes fractional seconds", () => {
	const field = { fieldtype: "Time" }
	assert.equal(formatFieldValue(field, "19:42:58.286926"), "19:42:58")
	assert.equal(formatFieldValue(field, "00:00:00.000000"), "00:00:00")
	assert.equal(formatFieldValue(field, "09:02:03"), "09:02:03")
	for (const value of [null, undefined, ""]) assert.equal(formatFieldValue(field, value), "—")
	assert.equal(formatFieldValue({ fieldtype: "Data" }, "19:42:58.286926"), "19:42:58.286926")
})

test("Details panel formats Posting Time without microseconds", async () => {
	const fields = [{ fieldname: "posting_time", fieldtype: "Time", label: "Posting Time" }]
	const page = await mountComponent("../../src/document/DetailsPanel.vue", {
		fields, meta: { fields, permissions: [] }, doc: { docstatus: 1, posting_time: "19:42:58.286926" }, disabled: true, user: { name: "Administrator" },
	})
	try {
		assert.match(textContent(page.root), /Posting Time\s*19:42:58/)
		assert.doesNotMatch(textContent(page.root), /286926/)
	} finally { page.close() }
})
