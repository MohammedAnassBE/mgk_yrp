import test from "node:test"
import assert from "node:assert/strict"
import { LiveDocument } from "../src/document/liveDocument.js"
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))

test("every event including own-save and unchanged modified coalesces into a fetch", async () => {
	let calls = 0
	const live = new LiveDocument({ reload: async () => { calls++ }, isDirty: () => false, isBusy: () => false, stale: () => assert.fail(), delay: 2 })
	live.update({ modified: "same" }); live.update({ modified: "same" })
	await wait()
	assert.equal(calls, 1)
	live.update({ modified: "same" })
	await wait()
	assert.equal(calls, 2)
	live.dispose()
})

test("events during save and during re-fetch are drained, and dirty documents get a sticky banner", async () => {
	let busy = true, dirty = false, banners = 0, calls = 0, release
	const live = new LiveDocument({ reload: async () => { calls++; if (calls === 1) await new Promise((resolve) => { release = resolve }) }, isDirty: () => dirty, isBusy: () => busy, stale: () => { banners++ }, delay: 2 })
	live.update()
	await wait()
	assert.equal(calls, 0)
	busy = false
	const first = live.flush()
	live.update()
	await wait()
	release()
	await first
	await wait()
	assert.equal(calls, 2)
	dirty = true
	live.update()
	await wait()
	assert.equal(calls, 2)
	assert.equal(banners, 1)
	live.dispose()
})
