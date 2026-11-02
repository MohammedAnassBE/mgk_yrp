import test from "node:test"
import assert from "node:assert/strict"
import { mountComponent, nodes, textContent, settle } from "./helpers/component.js"
import { defaultTerms } from "./helpers/terms.js"
import { bookManifest } from "../src/books/manifest.js"
import { setLanguage } from "../src/shell/displayLanguage.js"
import { setTerms } from "../src/shell/terminology.js"

async function inLanguages(boot, run) {
	const original = globalThis.window
	globalThis.window = { frappe: { boot: { terms: defaultTerms(), ...boot } } }
	setTerms(null)
	try {
		for (const language of ["ta", "en"]) { setLanguage(language); await run(language) }
	} finally { globalThis.window = original; setTerms(null); setLanguage("en") }
}

const text = (root) => textContent(root).replace(/\s+/g, " ").trim()

test("home book cards show book name, description, count and New in the display language", async () => {
	const book = bookManifest.find((entry) => entry.key === "purchase-order")
	await inLanguages({ user: { can_create: ["MGK Purchase Order"] } }, async (language) => {
		const page = await mountComponent("../../src/shared/BookCard.vue", { book, count: 3 })
		try {
			const expected = language === "ta"
				? ["கொள்முதல் ஆணை", "கொள்முதல், அளவுகள் மற்றும் டெலிவரிகளைத் திட்டமிடவும்.", "3 பதிவுகள்", "புத்தகத்தைத் திற", "+ புதியது"]
				: ["Purchase Order", "Plan purchases, quantities and deliveries.", "3 records", "Open book", "+ New"]
			for (const words of expected) assert.ok(text(page.root).includes(words), `${language}: ${words}`)
		} finally { page.close() }
	})
})

test("list tabs and toolbar switch words with the language", async () => {
	const book = bookManifest.find((entry) => entry.key === "delivery-challan")
	await inLanguages({}, async (language) => {
		const tabs = await mountComponent("../../src/list/ListTabs.vue", { tabs: book.tabs, counts: {}, total: 4, ready: true })
		const toolbar = await mountComponent("../../src/list/ListToolbar.vue", { filterCount: 1, sortFields: [{ fieldname: "posting_date", label: "Date" }] })
		try {
			const buttons = nodes(tabs.root, (node) => node.tag === "button").map(text)
			const words = text(toolbar.root)
			if (language === "ta") {
				assert.deepEqual(buttons.map((label) => label.split(" ")[0]), ["அனைத்தும்", "திற", "வழியில்", "மூடப்பட்டது", "திருப்புகள்"])
				assert.ok(text(tabs.root).includes("4 பதிவுகள்"))
				for (const word of ["வடிகட்டிகள்", "நெடுவரிசைகள்", "தேதி", "கடைசியாகப் புதுப்பித்தது"]) assert.ok(words.includes(word), word)
			} else {
				assert.deepEqual(buttons.map((label) => label.replace(/ \d+$/, "")), ["All", "Open", "In Transit", "Closed", "Returns"])
				for (const word of ["Filters", "Columns", "Date", "Last Updated", "Clear Filters"]) assert.ok(words.includes(word), word)
			}
		} finally { tabs.close(); toolbar.close() }
	})
})

test("status pills, column labels and empty states on the list follow the terms", async () => {
	await inLanguages({}, async (language) => {
		const page = await mountComponent("../../src/shared/NoAccess.vue", {})
		try {
			assert.ok(text(page.root).includes(language === "ta" ? "அனுமதி இல்லை" : "No access"))
		} finally { page.close() }
		const { statusPill } = await import("../src/list/statusPill.js")
		const { t } = await import("../src/shell/terminology.js")
		assert.equal(t(statusPill("MGK Purchase Order", { status: "To Receive" }).label), language === "ta" ? "பெற வேண்டியது" : "To Receive")
		assert.equal(t("Total Qty"), language === "ta" ? "மொத்த அளவு" : "Total Qty")
	})
})

test("an edited term reaches a mounted screen without a reload", async () => {
	await inLanguages({}, async (language) => {
		if (language !== "ta") return
		const page = await mountComponent("../../src/shared/NotFound.vue", {})
		try {
			assert.ok(text(page.root).includes("பக்கம் கிடைக்கவில்லை"))
			setTerms({ ...defaultTerms(), "Page not found": { source: "Page not found", ta: "பக்கம் இல்லை" } })
			await settle()
			assert.ok(text(page.root).includes("பக்கம் இல்லை"))
		} finally { page.close() }
	})
})
