export function editorMode(doc) {
	if (doc.doctype === "MGK Process Planning") return "plan"
	if (doc.doctype === "MGK Purchase Order") return "po"
	if (doc.doctype === "MGK Delivery Challan") return doc.is_return ? "dc_return" : "dc"
	return doc.against_purchase_order ? "grn_po" : "grn_job"
}

export function usesAttributeColumns(mode) { return ["grn_job", "plan"].includes(mode) }

export function editorPermissions(mode, editable = true) {
	const locked = ["dc_return", "grn_po"].includes(mode)
	return { canCreate: editable && mode !== "dc_return", canEdit: editable && !locked,
		canRemove: editable && !locked, rateEditable: editable && !locked && mode !== "plan",
		lockDimensionsOnEdit: mode === "dc_return", inlineQtyMaxField: locked ? "allowed_qty" : "" }
}

export function sameAttributes(left, right) {
	return JSON.stringify(Object.entries(left || {}).sort()) === JSON.stringify(Object.entries(right || {}).sort())
}

export function preparePurchaseOrderEntry(entry, sources) {
	const matching = sources.filter((source) => source.name === entry.name && sameAttributes(source.attributes, entry.attributes))
	for (const [key, cell] of Object.entries(entry.values)) {
		if (!cell || !Number(cell.qty)) continue
		const matches = matching.map((source) => source.values[key]).filter((source) => source?.purchase_order_item
			&& (!cell.purchase_order_item || source.purchase_order_item === cell.purchase_order_item))
		if (matches.length !== 1) throw new Error("Expected exactly one Purchase Order row for this item variant.")
		const { purchase_order_item, rate, uom, stock_uom, conversion_factor, pending_qty, allowed_qty } = matches[0]
		Object.assign(cell, { purchase_order_item, rate, uom, stock_uom, conversion_factor, pending_qty, allowed_qty })
	}
	return entry
}

export function validateItem(entry, mode, sources = []) {
	if (mode === "grn_po") preparePurchaseOrderEntry(entry, sources)
	if (mode === "po" && Object.values(entry.values).some((cell) => Number(cell?.qty) && !(Number(cell.rate) > 0))) {
		throw new Error("Rate must be greater than zero.")
	}
	return true
}

export function recalculate(groups, mode) {
	let quantity = 0
	let amount = 0
	for (const group of groups) for (const entry of group.items) for (const cell of Object.values(entry.values)) {
		if (!cell) continue
		cell.amount = (Number(cell.qty) || 0) * (Number(cell.rate) || 0)
		quantity += Number(cell.qty) || 0
		amount += cell.amount
	}
	return { total_qty: quantity, [mode.startsWith("dc") ? "total_declared_value" : "total_amount"]: amount }
}

export function itemFilters(mode, { poEntries = [], itemGroup = "" } = {}) {
	const filters = { is_stock_item: 1, disabled: 0, variant_of: ["is", "not set"] }
	if (mode === "grn_po") filters.name = ["in", poEntries.map((entry) => entry.name)]
	if (mode === "po" && itemGroup) filters.item_group = itemGroup
	return filters
}
