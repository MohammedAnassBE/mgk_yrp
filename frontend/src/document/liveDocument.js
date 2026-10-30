export class LiveDocument {
	constructor({ reload, isDirty, isBusy, stale, delay = 300 }) {
		Object.assign(this, { reload, isDirty, isBusy, stale, delay })
		this.pending = false
		this.running = false
		this.disposed = false
	}

	update() {
		if (this.disposed) return
		this.pending = true
		clearTimeout(this.timer)
		this.timer = setTimeout(() => this.flush(), this.delay)
	}

	async flush() {
		if (this.disposed || !this.pending || this.running || this.isBusy()) return
		this.pending = false
		if (this.isDirty()) { this.stale(); return }
		this.running = true
		try { await this.reload() }
		finally {
			this.running = false
			if (this.pending && !this.disposed) this.update()
		}
	}

	dispose() { this.disposed = true; clearTimeout(this.timer) }
}
