import { reactive } from "vue"
import { callRead } from "../api/client.js"

export class PreviewLoader {
	constructor({ read = callRead, state = reactive({ preview: null, loading: false, error: "" }), delay = 120 } = {}) {
		Object.assign(this, { read, state, delay })
		this.sequence = 0
		this.cache = new Map()
	}

	key(doctype, name, modified) { return JSON.stringify([doctype, name, modified || ""]) }

	cancel() {
		clearTimeout(this.timer)
		this.sequence += 1
		this.resolvePending?.(null)
		this.resolvePending = null
	}

	clear() {
		this.cancel()
		Object.assign(this.state, { preview: null, loading: false, error: "" })
	}

	invalidate(doctype, name) {
		if (!doctype) { this.cache.clear(); return }
		for (const key of this.cache.keys()) {
			const [cachedDoctype, cachedName] = JSON.parse(key)
			if (cachedDoctype === doctype && cachedName === name) this.cache.delete(key)
		}
	}

	loadPreview(doctype, name, { modified = "", immediate = false, force = false } = {}) {
		this.clear()
		if (!name) return Promise.resolve(null)
		if (force) this.invalidate(doctype, name)
		const sequence = this.sequence
		this.state.loading = true
		return new Promise((resolve) => {
			this.resolvePending = resolve
			const run = () => this.fetch(doctype, name, modified, sequence).then(resolve)
			if (immediate) run()
			else this.timer = setTimeout(run, this.delay)
		})
	}

	async fetch(doctype, name, modified, sequence) {
		const key = this.key(doctype, name, modified)
		try {
			const preview = this.cache.get(key) || await this.read("mgk_yrp.web.preview.get_preview", { doctype, name })
			if (sequence !== this.sequence) return null
			this.cache.set(key, preview)
			if (preview.doc.modified) this.cache.set(this.key(doctype, name, preview.doc.modified), preview)
			if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value)
			this.state.preview = preview
			return preview
		} catch (cause) {
			if (sequence === this.sequence) this.state.error = cause.message
			return null
		} finally {
			if (sequence === this.sequence) { this.state.loading = false; this.resolvePending = null }
		}
	}
}

export function usePreview(options) { return new PreviewLoader(options) }
