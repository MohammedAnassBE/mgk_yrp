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
	if (!hasQuantity(groups)) throw new Error("Enter Qty to continue")
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
		group = { attributes: clone(details.attributes || []), primary_attribute: details.primary_attribute || "",
			primary_attribute_values: clone(details.primary_attribute_values || []), items: [] }
		groups.push(group)
	}
	group.items.push(clone(entry))
}
