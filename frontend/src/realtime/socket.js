import { invalidateReads } from "../api/client.js"

export function socketUrl(boot, location) {
	if (!boot.site_name) throw new Error("Realtime needs a site name in boot.")
	const origin = boot.dev_server ? `${location.protocol}//${location.hostname}:${boot.socketio_port}` : location.origin
	return `${origin}/${boot.site_name}`
}

export const socketOptions = { autoConnect: false, withCredentials: true, reconnection: true,
	reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000 }

async function createSocket() {
	const { io } = await import("socket.io-client")
	return io(socketUrl(window.frappe?.boot || {}, window.location), socketOptions)
}

export class RealtimeConnection {
	constructor(factory = createSocket, warn = (...args) => console.warn(...args)) {
		this.factory = factory
		this.warn = warn
		this.rooms = new Map()
		this.reconnectHandlers = new Set()
		this.stateHandlers = new Set()
		this.state = "OFFLINE"
		this.connectedBefore = false
		this.warned = false
		this.socket = null
		this.pending = null
		this.online = () => {
			if (this.socket?.connected) return
			if (this.socket) this.socket.connect()
			else { this.pending = null; this.start() }
		}
	}

	start() {
		if (this.pending) return this.pending
		if (!this.onlineListening && globalThis.window?.addEventListener) {
			window.addEventListener("online", this.online)
			this.onlineListening = true
		}
		this.pending = Promise.resolve().then(this.factory).then((socket) => {
			this.socket = socket
			socket.on("connect", () => this.connected())
			socket.on("disconnect", () => this.setState("OFFLINE"))
			socket.on("connect_error", (error) => this.failed(error))
			socket.on("list_update", (event) => this.dispatch("doctype", event))
			socket.on("doc_update", (event) => this.dispatch("doc", event))
			if (socket.connected) this.connected()
			else socket.connect()
			return socket
		}).catch((error) => {
			this.failed(error)
			return null
		})
		return this.pending
	}

	setState(state) {
		this.state = state
		for (const handler of this.stateHandlers) handler(state)
	}

	failed(error) {
		this.setState("OFFLINE")
		if (this.warned) return
		this.warned = true
		this.warn("MGK realtime is offline; pages remain available.", error)
	}

	connected() {
		invalidateReads()
		this.setState("LIVE")
		for (const room of this.rooms.values()) this.emitRoom(room, "subscribe")
		if (this.connectedBefore) {
			for (const handler of this.reconnectHandlers) handler()
		}
		this.connectedBefore = true
	}

	emitRoom(room, action) {
		if (room.type === "doc" && action === "subscribe") {
			this.socket.emit("mgk_doc_subscribe", ...room.args, () => {
				if (this.rooms.get(JSON.stringify([room.type, ...room.args])) !== room) return
				invalidateReads()
				for (const handler of room.handlers) handler({ subscribed: true })
			})
			return
		}
		this.socket.emit(`${room.type}_${action}`, ...room.args)
	}

	dispatch(type, event) {
		if (!event?.doctype) return
		invalidateReads()
		const key = JSON.stringify(type === "doc" ? [type, event.doctype, event.name] : [type, event.doctype])
		for (const handler of this.rooms.get(key)?.handlers || []) handler(event)
	}

	subscribe(type, args, handler) {
		const key = JSON.stringify([type, ...args])
		let room = this.rooms.get(key)
		if (!room) {
			room = { type, args, handlers: new Set() }
			this.rooms.set(key, room)
			if (this.socket?.connected) this.emitRoom(room, "subscribe")
		}
		const callback = (event) => handler(event)
		room.handlers.add(callback)
		this.start()
		return () => {
			if (!room.handlers.delete(callback) || room.handlers.size) return
			this.rooms.delete(key)
			if (this.socket?.connected) this.emitRoom(room, "unsubscribe")
		}
	}

	subscribeDoctype(doctype, handler) { return this.subscribe("doctype", [doctype], handler) }
	subscribeDoc(doctype, name, handler) { return this.subscribe("doc", [doctype, name], handler) }

	onReconnect(handler) {
		this.reconnectHandlers.add(handler)
		this.start()
		return () => this.reconnectHandlers.delete(handler)
	}

	onState(handler) {
		this.stateHandlers.add(handler)
		handler(this.state)
		this.start()
		return () => this.stateHandlers.delete(handler)
	}
}

export const realtime = new RealtimeConnection()
export const subscribeDoctype = (doctype, handler) => realtime.subscribeDoctype(doctype, handler)
export const subscribeDoc = (doctype, name, handler) => realtime.subscribeDoc(doctype, name, handler)
export const onReconnect = (handler) => realtime.onReconnect(handler)
