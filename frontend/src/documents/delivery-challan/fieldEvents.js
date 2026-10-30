export function deliveryChallanChanges(name, doc) {
	if (doc.is_return) return {}
	if (name === "from_location") return { from_warehouse: null }
	if (name === "to_location") return { to_warehouse: null }
	return {}
}

export function processFilters(meta) {
	const names = new Set(meta.fields.map((field) => field.fieldname))
	return names.has("disabled") ? { disabled: 0 } : names.has("enabled") ? { enabled: 1 } : {}
}

export function createFieldEvents({ getDoc, call, getMeta, markAuto, setCandidates }) {
	function change(name) { Object.assign(getDoc(), deliveryChallanChanges(name, getDoc())) }
	async function load() {
		const doc = getDoc()
		if (!doc.__islocal || doc.is_return || doc.process_name) return
		const metas = await getMeta("YRP Process")
		const meta = metas.find((entry) => entry.name === "YRP Process")
		if (!meta) throw new Error("Process metadata is unavailable.")
		const processes = await call("frappe.client.get_list", {
			doctype: "YRP Process", fields: ["name"], filters: processFilters(meta), limit_page_length: 0,
		})
		if (getDoc() !== doc || doc.is_return || Number(doc.docstatus) !== 0) return
		setCandidates("process_name", processes.map((process) => process.name))
		if (!doc.process_name && processes.length === 1) {
			doc.process_name = processes[0].name
			markAuto(["process_name"])
		}
	}
	return { change, load }
}
