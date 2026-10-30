import { countRequests, orderedTabs, rowParameters, PAGE_SIZE } from "./listQuery.js"

export function initialListData() {
	return { rows: [], counts: {}, total: 0, allTotal: 0, loading: false, loadingMore: false, countsReady: false, error: "", moreError: "" }
}

export class ListLoader {
	constructor({ doctype, getRows, getCounts, query, fields, state = initialListData() }) {
		Object.assign(this, { doctype, getRows, getCounts, query, fields, state })
		this.loadSequence = 0
	}

	async load(limit = PAGE_SIZE) {
		const sequence = ++this.loadSequence
		const query = JSON.parse(JSON.stringify(this.query()))
		Object.assign(this.state, { loading: true, loadingMore: false, error: "", moreError: "" })
		try {
			const [rows, counts] = await Promise.all([
				this.getRows(this.doctype, rowParameters(query, this.fields(), 0, limit)),
				this.getCounts(countRequests(this.doctype, query)),
			])
			if (sequence !== this.loadSequence) return false
			const tabs = orderedTabs(query.tabs)
			const tabIndex = Math.max(0, tabs.findIndex((tab) => tab.key === query.tab))
			Object.assign(this.state, {
				rows, counts: Object.fromEntries(tabs.map((tab, index) => [tab.key, counts[index + 1]])),
				total: counts[tabIndex + 1], allTotal: counts[0], countsReady: true,
			})
			return true
		} catch (cause) {
			if (sequence === this.loadSequence) this.state.error = cause.message
			return false
		} finally {
			if (sequence === this.loadSequence) this.state.loading = false
		}
	}

	async more() {
		if (this.state.loading || this.state.loadingMore || this.state.rows.length >= this.state.total) return
		const sequence = this.loadSequence
		const start = this.state.rows.length
		Object.assign(this.state, { loadingMore: true, moreError: "" })
		try {
			const rows = await this.getRows(this.doctype, rowParameters(this.query(), this.fields(), start, PAGE_SIZE))
			if (sequence !== this.loadSequence) return
			const existing = new Set(this.state.rows.map((row) => row.name))
			this.state.rows = [...this.state.rows, ...rows.filter((row) => !existing.has(row.name))]
			if (rows.length < PAGE_SIZE) this.state.total = this.state.rows.length
		} catch (cause) {
			if (sequence === this.loadSequence) this.state.moreError = cause.message
		} finally {
			if (sequence === this.loadSequence) this.state.loadingMore = false
		}
	}

	dispose() { this.loadSequence += 1 }
}
