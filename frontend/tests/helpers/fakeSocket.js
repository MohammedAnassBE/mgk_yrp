export class FakeSocket {
	constructor() { this.handlers = new Map(); this.emitted = []; this.connected = false }
	on(event, handler) {
		if (!this.handlers.has(event)) this.handlers.set(event, new Set())
		this.handlers.get(event).add(handler)
	}
	emit(...args) { this.emitted.push(args) }
	connect() { this.connected = true; this.fire("connect"); return this }
	disconnect() { this.connected = false; this.fire("disconnect"); return this }
	fire(event, payload) { for (const handler of this.handlers.get(event) || []) handler(payload) }
}
