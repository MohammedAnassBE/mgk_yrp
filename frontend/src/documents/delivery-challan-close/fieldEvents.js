export function createFieldEvents({ getDoc, callDoc, messages = () => {} }) {
	let sequence = 0
	async function preview() {
		const doc = getDoc()
		const source = doc.delivery_challan
		const current = ++sequence
		if (Number(doc.docstatus) !== 0 || !source) return
		try {
			const result = await callDoc(doc, "preview")
			if (getDoc() !== doc || doc.delivery_challan !== source || current !== sequence) return
			if (!result.doc) throw new Error("The server returned no Close preview.")
			Object.assign(doc, result.doc)
			messages(result.messages || [])
		} catch (cause) {
			if (getDoc() === doc && doc.delivery_challan === source && current === sequence) throw cause
		}
	}
	async function change(name) { if (name === "delivery_challan") await preview() }
	return { change, load: preview }
}
