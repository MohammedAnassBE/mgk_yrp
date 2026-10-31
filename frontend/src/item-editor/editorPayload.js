import { clone } from "../document/mappedDraft.js"

export function loadItems(data, mode) {
	const groups = clone(typeof data === "string" ? JSON.parse(data) : data || [])
	const link = { grn_po: "purchase_order_item", dc_return: "against_dc_item" }[mode]
	for (const group of groups) for (const entry of group.items) for (const [key, cell] of Object.entries(entry.values)) {
		if (!cell) continue
		if (cell.__islocal || cell.name?.startsWith("new-")) delete cell.name
		if (link && !cell[link]) entry.values[key] = null
	}
	return groups
}

export function getItems(groups) { return clone(groups) }

export function hasQuantity(groups) {
	return groups.some((group) => group.items.some((entry) => Object.values(entry.values).some((cell) => Number(cell?.qty) > 0)))
}

export function editorSavePayload(doc, groups) {
	const hasPrefilled = groups.some((group) => group.items.some((entry) => Object.values(entry.values).some((cell) => cell?.is_prefilled)))
	const isJobDraft = doc.doctype === "MGK Goods Received Note" && !doc.against_purchase_order && !Number(doc.docstatus)
	if (!hasQuantity(groups) && !(isJobDraft && hasPrefilled)) throw new Error("Enter Qty to continue")
	return { ...clone(doc), item_details: JSON.stringify(getItems(groups)), items: [] }
}

export function replaceEntry(groups, groupIndex, entryIndex, edited) {
	groups[groupIndex].items[entryIndex] = clone(edited)
}

export function addEntry(groups, details, entry) {
	let group = groups.find((group) => JSON.stringify(group.attributes) === JSON.stringify(details.attributes || [])
		&& group.primary_attribute === (details.primary_attribute || "")
		&& JSON.stringify(group.primary_attribute_values) === JSON.stringify(details.primary_attribute_values || []))
	if (!group) {
		group = { ...clone(details), attributes: clone(details.attributes || []), primary_attribute: details.primary_attribute || "",
			primary_attribute_values: clone(details.primary_attribute_values || []), items: [] }
		groups.push(group)
	}
	group.items.push(clone(entry))
}

export function addSplit(groups, groupIndex, entryIndex) {
	const group = groups[groupIndex]
	const entry = clone(group.items[entryIndex])
	delete entry.row_index
	for (const [key, cell] of Object.entries(entry.values)) {
		if (!cell || !(Number(cell.qty) > 0 || cell.is_prefilled || cell.name)) {
			entry.values[key] = null
			continue
		}
		Object.assign(cell, { qty: 0, amount: 0, is_prefilled: 1 })
		delete cell.name
	}
	group.items.splice(entryIndex + 1, 0, entry)
}

export function attachTransferredQuantities(groups, rows = []) {
	const quantities = new Map(rows.filter((row) => row.name).map((row) => [row.name, row.transferred_qty]))
	for (const group of groups) for (const entry of group.items) for (const cell of Object.values(entry.values)) {
		if (cell && quantities.has(cell.name)) cell.transferred_qty = quantities.get(cell.name) ?? 0
	}
	return groups
}
