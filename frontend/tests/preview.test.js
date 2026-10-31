import test from "node:test"
import assert from "node:assert/strict"
import { PreviewLoader } from "../src/list/usePreview.js"
import { createApp, effectScope } from "vue"
import { routerKey } from "vue-router"
import { useActionRunner } from "../src/document/useActionRunner.js"

function deferred() {
	let resolve
	const promise = new Promise((done) => { resolve = done })
	return { promise, resolve }
}
const preview = (name, modified = "one") => ({ doc: { name, modified }, items: [], connections: [], timeline: [], extra: {} })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test("stale preview responses never replace the last selection", async () => {
	const first = deferred()
	const second = deferred()
	const loader = new PreviewLoader({ read: (_method, { name }) => name === "A" ? first.promise : second.promise })
	const loadingFirst = loader.loadPreview("MGK Purchase Order", "A", { immediate: true })
	const loadingSecond = loader.loadPreview("MGK Purchase Order", "B", { immediate: true })
	second.resolve(preview("B"))
	await loadingSecond
	first.resolve(preview("A"))
	await loadingFirst
	await flush()
	assert.equal(loader.state.preview.doc.name, "B")
	assert.equal(loader.state.loading, false)
})

test("selection changes debounce for 120ms and clear the old preview immediately", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const requests = []
	const loader = new PreviewLoader({ read: async (_method, { name }) => { requests.push(name); return preview(name) } })
	loader.state.preview = preview("old")
	const first = loader.loadPreview("MGK Purchase Order", "A")
	assert.equal(loader.state.preview, null)
	context.mock.timers.tick(90)
	const last = loader.loadPreview("MGK Purchase Order", "B")
	assert.equal(await first, null)
	context.mock.timers.tick(119)
	assert.deepEqual(requests, [])
	context.mock.timers.tick(1)
	await last
	assert.deepEqual(requests, ["B"])
	assert.equal(loader.state.preview.doc.name, "B")
	loader.clear()
})

test("cache includes doctype, name and modified and live invalidation forces a read", async () => {
	let requests = 0
	const loader = new PreviewLoader({ read: async (_method, { name }) => { requests++; return preview(name) } })
	const load = (doctype = "MGK Purchase Order", modified = "one", force = false) => loader.loadPreview(doctype, "A", { modified, immediate: true, force })
	await load()
	await load()
	assert.equal(requests, 1)
	await load("MGK Purchase Order", "two")
	await load("MGK Delivery Challan")
	assert.equal(requests, 3)
	loader.invalidate("MGK Purchase Order", "A")
	await load()
	await load("MGK Purchase Order", "one", true)
	assert.equal(requests, 5)
})

test("clear cancels pending work and stale errors cannot replace current success", async () => {
	let reject
	const stale = new Promise((_resolve, fail) => { reject = fail })
	const loader = new PreviewLoader({ read: (_method, { name }) => name === "A" ? stale : Promise.resolve(preview(name)) })
	loader.loadPreview("MGK Purchase Order", "A", { immediate: true })
	await loader.loadPreview("MGK Purchase Order", "B", { immediate: true })
	reject(new Error("old error"))
	await flush()
	assert.equal(loader.state.error, "")
	loader.clear()
	assert.equal(loader.state.preview, null)
	assert.equal(loader.state.loading, false)
})

test("failed reads expose the server message and can be retried", async () => {
	let hasFailed = false
	const loader = new PreviewLoader({ read: async () => {
		if (!hasFailed) { hasFailed = true; throw new Error("Not permitted to read this order.") }
		return preview("A")
	} })
	await loader.loadPreview("MGK Purchase Order", "A", { immediate: true })
	assert.equal(loader.state.error, "Not permitted to read this order.")
	await loader.loadPreview("MGK Purchase Order", "A", { immediate: true, force: true })
	assert.equal(loader.state.error, "")
	assert.equal(loader.state.preview.doc.name, "A")
})

test("bulk cache invalidation cannot be undone by an outstanding stale response", async () => {
	const pending = deferred()
	let requests = 0
	const loader = new PreviewLoader({ read: async (_method, { name }) => ++requests === 1 ? pending.promise : preview(name) })
	const stale = loader.loadPreview("MGK Purchase Order", "A", { immediate: true })
	loader.invalidate()
	loader.clear()
	await loader.loadPreview("MGK Purchase Order", "B", { immediate: true })
	pending.resolve(preview("A")); await stale; await flush()
	assert.equal(loader.cache.has(loader.key("MGK Purchase Order", "A", "one")), false)
	await loader.loadPreview("MGK Purchase Order", "A", { modified: "one", immediate: true })
	assert.equal(requests, 3)
})

test("reset ignores stale mutation results, errors, navigation and reload without unlocking it", async () => {
	for (const hasError of [false, true]) {
		const app = createApp({}), scope = effectScope(), pending = deferred()
		let calls = 0, reloads = 0, navigations = 0
		app.provide(routerKey, { push: () => { navigations++ } })
		const runner = scope.run(() => app.runWithContext(() => useActionRunner({ reload: async () => { reloads++ } })))
		const action = { key: "mutate", run: async (_target, { navigate }) => {
			calls++
			await pending.promise
			if (hasError) throw new Error("Old document error")
			await navigate("/old-document")
			return { message: "Old document result" }
		} }
		try {
			const running = runner.run(action, { doc: { name: "A" } })
			runner.reset()
			assert.equal(runner.busy.value, true)
			await runner.run(action, { doc: { name: "B" } })
			assert.equal(calls, 1)
			pending.resolve(); await running
			assert.equal(runner.busy.value, false)
			assert.equal(runner.result.value, null)
			assert.equal(runner.error.value, "")
			assert.equal(reloads, 0)
			assert.equal(navigations, 0)
			await runner.run({ key: "current", run: async () => ({ message: "Current document" }) }, { doc: { name: "B" } })
			assert.equal(runner.result.value.message, "Current document")
			assert.equal(reloads, 1)
		} finally { pending.resolve(); scope.stop() }
	}
})
