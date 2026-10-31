import test from "node:test"
import assert from "node:assert/strict"
import { formatDate, formatDatetime, toIsoDate } from "../src/shared/formatDate.js"
import { formatFieldValue } from "../src/document/fieldDisplay.js"
import { lastRateText } from "../src/item-editor/useLastRates.js"
import * as receipt from "../src/documents/goods-received-note/preview.js"

test("formatDate renders DD-MM-YYYY and datetimes DD-MM-YYYY HH:mm", () => {
	assert.equal(formatDate("2026-10-31"), "31-10-2026")
	assert.equal(formatDate("2026-10-31 14:05:09.123456"), "31-10-2026")
	assert.equal(formatDatetime("2026-10-31 14:05:09.123456"), "31-10-2026 14:05")
	assert.equal(formatDatetime("2026-10-31T09:30:00"), "31-10-2026 09:30")
	assert.equal(formatDatetime("2026-10-31"), "31-10-2026")
	assert.equal(formatDate(new Date(2026, 0, 5)), "05-01-2026")
	assert.equal(formatDatetime(new Date(2026, 0, 5, 7, 3)), "05-01-2026 07:03")
	assert.equal(formatDate(""), "")
	assert.equal(formatDate(null), "")
})

test("toIsoDate keeps server values as YYYY-MM-DD", () => {
	assert.equal(toIsoDate(new Date(2026, 9, 31)), "2026-10-31")
	assert.equal(toIsoDate(null), "")
})

test("field, preview and hint displays use DD-MM-YYYY", () => {
	assert.equal(formatFieldValue({ fieldtype: "Date" }, "2026-10-31"), "31-10-2026")
	assert.equal(formatFieldValue({ fieldtype: "Datetime" }, "2026-10-31 08:15:00"), "31-10-2026 08:15")
	const posting = receipt.facts({ posting_date: "2026-10-30" }).find((fact) => fact.label === "Posting Date")
	assert.equal(posting.value, "30-10-2026")
	assert.match(lastRateText({ rate: 12, purchase_order: "PO-1", po_date: "2026-09-04" }), /· 04-09-2026$/)
})
