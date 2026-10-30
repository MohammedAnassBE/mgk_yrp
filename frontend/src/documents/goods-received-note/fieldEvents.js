export const makeGoodsReceivedNote = "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.make_goods_received_note"

export function purchaseOrderFilters(doc) {
	return { docstatus: 1, status: ["in", ["To Receive", "Partially Received"]], ...(doc.supplier ? { supplier: doc.supplier } : {}) }
}

export function goodsReceivedNoteChanges(name, doc) {
	if (name === "supplier") return { delivery_challans: [] }
	if (name === "delivery_location") return { warehouse: "" }
	if (!["against_purchase_order", "purchase_order"].includes(name)) return {}
	return { items: [], item_details: null, __onload: { ...doc.__onload, item_details: [] }, total_qty: 0, total_amount: 0,
		...(name === "against_purchase_order" ? { purchase_order: "", delivery_challans: [] } : {}) }
}

export function isCurrentPurchaseOrderRequest(getDoc, doc, version, current, source) {
	return getDoc() === doc && version === current && doc.purchase_order === source && Boolean(doc.against_purchase_order)
}

export function createFieldEvents({ getDoc, call, markAuto = () => {} }) {
	let sequence = 0
	async function change(name) {
		const doc = getDoc()
		Object.assign(doc, goodsReceivedNoteChanges(name, doc))
		if (!["against_purchase_order", "purchase_order"].includes(name)) return
		const version = ++sequence
		const source = doc.purchase_order
		const isCurrent = () => isCurrentPurchaseOrderRequest(getDoc, doc, version, sequence, source)
		if (name !== "purchase_order" || !source || !isCurrent()) return
		try {
			const result = await call(makeGoodsReceivedNote, { source_name: source })
			if (!isCurrent()) return
			Object.assign(doc, { supplier: result.supplier, delivery_location: result.delivery_location,
				warehouse: result.warehouse, total_qty: result.total_qty, total_amount: result.total_amount,
				delivery_challans: [], __onload: { ...doc.__onload, item_details: result.__onload.item_details } })
			markAuto(["supplier", "delivery_location", "warehouse"])
		} catch (cause) { if (isCurrent()) throw cause }
	}
	return { change }
}

export function fieldOverrides(field) {
	return ["supplier", "delivery_location"].includes(field.fieldname)
		? { ...field, read_only_depends_on: "eval:doc.against_purchase_order" } : field
}

export function initialAutoFields(doc) {
	return doc?.__islocal && doc.against_purchase_order && doc.purchase_order
		? ["supplier", "delivery_location", "warehouse"].filter((name) => doc[name]) : []
}
