import test from "node:test"
import assert from "node:assert/strict"
import { RealtimeConnection, socketOptions, socketUrl } from "../src/realtime/socket.js"
import { callRead, clearReadCaches } from "../src/api/client.js"
import { ListLoader } from "../src/list/listLoader.js"
import { FakeSocket } from "./helpers/fakeSocket.js"

test("realtime refresh bypasses a delayed pre-commit snapshot for both rows and counts", async () => {
	const original = globalThis.fetch
	const releases = []
	let version = "old", requests = 0, refresh
	globalThis.fetch = async (url) => {
		requests++
		const snapshot = version
		if (snapshot === "old") await new Promise((resolve) => releases.push(resolve))
		return { ok: true, status: 200, json: async () => ({ message: url.includes("rows") ? [{ name: snapshot }] : [snapshot === "old" ? 1 : 2, 2] }) }
	}
	const loader = new ListLoader({ doctype: "PO", query: () => ({}), fields: () => ["name"],
		getRows: () => callRead("rows"), getCounts: () => callRead("counts") })
	const socket = new FakeSocket()
	const connection = new RealtimeConnection(() => socket)
	const dispose = connection.subscribeDoctype("PO", () => { refresh = loader.load() })
	try {
		await connection.start()
		const old = loader.load()
		version = "committed"
		socket.fire("list_update", { doctype: "PO" })
		await refresh
		assert.equal(requests, 4)
		releases.forEach((release) => release()); await old
		assert.equal(loader.state.rows[0].name, "committed")
		assert.equal(loader.state.total, 2)
	} finally { releases.forEach((release) => release()); dispose(); loader.dispose(); globalThis.fetch = original; clearReadCaches() }
})

test("long outages keep retrying and browser online recovery rejoins rooms and fetches catch-up data", async () => {
	assert.equal(socketOptions.reconnection, true)
	assert.equal(socketOptions.reconnectionAttempts, Infinity)
	assert.equal(socketOptions.reconnectionDelayMax, 10000)
	const original = globalThis.window
	const listeners = {}
	globalThis.window = { addEventListener: (event, handler) => { listeners[event] = handler } }
	const socket = new FakeSocket()
	const connection = new RealtimeConnection(() => socket, () => {})
	let fetches = 0
	const dispose = connection.subscribeDoc("PO", "PO-1", () => {})
	const stop = connection.onReconnect(() => { fetches++; assert.equal(socket.emitted.at(-1)[0], "mgk_doc_subscribe") })
	try {
		await connection.start()
		socket.disconnect()
		for (let attempt = 0; attempt < 8; attempt++) socket.fire("connect_error", new Error("Offline"))
		listeners.online()
		assert.equal(connection.state, "LIVE")
		assert.equal(fetches, 1)
		assert.equal(socket.emitted.filter((args) => args[0] === "mgk_doc_subscribe").length, 2)
	} finally { dispose(); stop(); globalThis.window = original }
})

test("socket URL uses host-only dev port and production origin with site namespace", () => {
	const location = { protocol: "http:", hostname: "mgk_new.site", origin: "http://mgk_new.site:8001" }
	assert.equal(socketUrl({ dev_server: true, socketio_port: 9001, site_name: "mgk_new.site" }, location), "http://mgk_new.site:9001/mgk_new.site")
	assert.equal(socketUrl({ dev_server: false, site_name: "mgk_new.site" }, location), "http://mgk_new.site:8001/mgk_new.site")
	assert.throws(() => socketUrl({}, location), /site name/)
})

test("overlapping subscribers share one doctype room and only the last disposal leaves", async () => {
	const socket = new FakeSocket()
	const connection = new RealtimeConnection(() => socket)
	const events = []
	const handler = (data) => events.push(data)
	const left = connection.subscribeDoctype("MGK Purchase Order", handler)
	const right = connection.subscribeDoctype("MGK Purchase Order", handler)
	await connection.start()
	assert.deepEqual(socket.emitted, [["doctype_subscribe", "MGK Purchase Order"]])
	socket.fire("list_update", { doctype: "MGK Purchase Order", name: "PO-1" })
	socket.fire("list_update", { doctype: "MGK Purchase Invoice", name: "PI-1" })
	assert.equal(events.length, 2)
	left(); left()
	assert.equal(socket.emitted.length, 1)
	right()
	assert.deepEqual(socket.emitted.at(-1), ["doctype_unsubscribe", "MGK Purchase Order"])
	socket.fire("list_update", { doctype: "MGK Purchase Order" })
	assert.equal(events.length, 2)
})

test("doc rooms ref-count independently, dispatch by name, and explicitly unsubscribe", async () => {
	const socket = new FakeSocket()
	const connection = new RealtimeConnection(() => socket)
	const events = []
	const one = connection.subscribeDoc("MGK Purchase Order", "PO-1", () => events.push(1))
	const two = connection.subscribeDoc("MGK Purchase Order", "PO-2", () => events.push(2))
	await connection.start()
	socket.fire("doc_update", { doctype: "MGK Purchase Order", name: "PO-2" })
	assert.deepEqual(events, [2])
	one(); two()
	assert.ok(socket.emitted.some((args) => args.join("|") === "doc_unsubscribe|MGK Purchase Order|PO-1"))
})

test("reconnect rejoins each live list/related/doc room before callbacks, once per reconnect", async () => {
	const socket = new FakeSocket()
	const connection = new RealtimeConnection(() => socket)
	connection.subscribeDoctype("MGK Purchase Order", () => {})
	connection.subscribeDoctype("MGK Goods Received Note", () => {})
	connection.subscribeDoc("MGK Purchase Order", "PO-1", () => {})
	let calls = 0
	const dispose = connection.onReconnect(() => { calls += 1; assert.equal(socket.emitted.length, 6) })
	await connection.start()
	assert.equal(calls, 0)
	socket.disconnect().connect()
	assert.equal(calls, 1)
	const rooms = (entries) => entries.map((args) => args.filter((arg) => typeof arg !== "function"))
	assert.deepEqual(rooms(socket.emitted.slice(0, 3)), rooms(socket.emitted.slice(3)))
	dispose()
	socket.disconnect().connect()
	assert.equal(calls, 1)
})

test("dispose while connecting never joins an obsolete room", async () => {
	const socket = new FakeSocket()
	let resolve
	const connection = new RealtimeConnection(() => new Promise((done) => { resolve = done }))
	const dispose = connection.subscribeDoctype("MGK Purchase Order", () => {})
	await Promise.resolve()
	dispose()
	resolve(socket)
	await connection.start()
	assert.deepEqual(socket.emitted, [])
})

test("socket auth errors log one warning and show OFFLINE, then recovery shows LIVE", async () => {
	const socket = new FakeSocket()
	const warnings = []
	const states = []
	const connection = new RealtimeConnection(() => socket, (...args) => warnings.push(args))
	const dispose = connection.onState((state) => states.push(state))
	await connection.start()
	socket.fire("connect_error", new Error("Unauthorized"))
	socket.fire("connect_error", new Error("Unauthorized"))
	assert.equal(warnings.length, 1)
	assert.equal(connection.state, "OFFLINE")
	socket.disconnect().connect()
	assert.equal(connection.state, "LIVE")
	assert.ok(states.includes("OFFLINE"))
	dispose()
})

test("lazy import/initialization failure is visible and does not reject page subscriptions", async () => {
	const warnings = []
	const connection = new RealtimeConnection(() => { throw new Error("Offline") }, (...args) => warnings.push(args))
	connection.subscribeDoctype("MGK Purchase Order", () => {})
	assert.equal(await connection.start(), null)
	assert.equal(connection.state, "OFFLINE")
	assert.equal(warnings.length, 1)
})
