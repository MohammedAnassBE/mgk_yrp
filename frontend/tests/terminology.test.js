import test from "node:test"
import assert from "node:assert/strict"
import { defaultTerms } from "./helpers/terms.js"
import { setLanguage, tabLabel } from "../src/shell/displayLanguage.js"
import { currentTerms, refreshTerms, setTerms, t, term, TERMS_METHOD } from "../src/shell/terminology.js"
import { RealtimeConnection } from "../src/realtime/socket.js"
import { FakeSocket } from "./helpers/fakeSocket.js"

const boot = { "mgk.purchase_order": { source: "Purchase Order", ta: "கொள்முதல் ஆணை" }, "mgk.save": { source: "Save", ta: "சேமி" } }

async function withBoot(terms, run) {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { terms } } }
	setTerms(null)
	try { return await run() } finally { globalThis.window = original; setTerms(null); setLanguage("en") }
}

test("t() returns English in English mode and the term's Tamil in Tamil mode", () => withBoot(boot, () => {
	setLanguage("en")
	assert.equal(t("Purchase Order"), "Purchase Order")
	setLanguage("ta")
	assert.equal(t("Purchase Order"), "கொள்முதல் ஆணை")
	assert.equal(t("PURCHASE  order"), "கொள்முதல் ஆணை", "lookup ignores case and spacing")
	assert.equal(t("Unknown words"), "Unknown words", "English stays when no term exists")
	assert.equal(t(""), "")
	assert.equal(term("mgk.save"), "சேமி")
	assert.equal(term("mgk.missing", "Fallback"), "Fallback")
	setLanguage("en")
	assert.equal(term("mgk.save"), "Save")
}))

test("an edited term replaces the boot term after a refresh", async () => {
	const original = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url) => {
		calls.push(String(url))
		return { ok: true, status: 200, json: async () => ({ message: { ...boot, "mgk.purchase_order": { source: "Purchase Order", ta: "வாங்கும் ஆணை" } } }) }
	}
	try {
		await withBoot(boot, async () => {
			setLanguage("ta")
			assert.equal(t("Purchase Order"), "கொள்முதல் ஆணை")
			await refreshTerms()
			assert.ok(calls[0].includes(TERMS_METHOD))
			assert.equal(t("Purchase Order"), "வாங்கும் ஆணை")
			assert.equal(currentTerms()["mgk.save"].ta, "சேமி")
		})
	} finally { globalThis.fetch = original }
})

test("site-wide realtime events reach their handlers", async () => {
	const socket = new FakeSocket()
	const connection = new RealtimeConnection(async () => socket, () => {})
	const seen = []
	const dispose = connection.onEvent("mgk_ui_terms_updated", (message) => seen.push(message))
	await connection.pending
	socket.fire("mgk_ui_terms_updated", { at: 1 })
	assert.deepEqual(seen, [{ at: 1 }])
	dispose()
})

test("tabs use the Item Group Tamil name only when set, else their term", () => withBoot(defaultTerms(), () => {
	setLanguage("ta")
	assert.equal(tabLabel({ key: "all", label: "All", filters: [] }), "அனைத்தும்")
	assert.equal(tabLabel({ key: "x", label: "Salavai Cone", filters: [] }), "சலவைக்கோன்")
	setLanguage("en")
	assert.equal(tabLabel({ key: "all", label: "All", filters: [] }), "All")
}))

test("shipped defaults keep the PO tab and print words", () => {
	const terms = defaultTerms()
	assert.equal(terms.Karigan.ta, "காரிகான்")
	assert.equal(terms["Salavai Cone"].ta, "சலவைக்கோன்")
	assert.equal(terms.All.ta, "அனைத்தும்")
	assert.equal(terms["Goods Received Note"].ta, "பொருள் வரவு குறிப்பு")
})
