import { displayName } from "../shell/displayLanguage.js"
import { callRead } from "../api/client.js"

export function nonPrimaryAttributes(group) {
	return [...new Set([...(group.attributes || []),
		...group.items.flatMap((entry) => Object.keys(entry.attributes || {}))])]
		.filter((attribute) => attribute !== group.primary_attribute)
}

export function sizes(group) {
	return group.primary_attribute_values?.length ? group.primary_attribute_values : ["default"]
}

export function columnOptions(current, options = []) {
	return [...new Set([current, ...options].filter(Boolean))]
}

export async function loadDimensionOptions(dimension) {
	const rows = await callRead("frappe.client.get_list", {
		doctype: dimension.options, fields: ["name"], limit_page_length: 0,
	})
	return rows.map((row) => row.name)
}

export function refreshEntryUom(group, entry) {
	const metadata = new Set(group.items.map((row) => row.name)).size === 1 ? group : {}
	const dependent = metadata.dependent_attribute
	const stage = metadata.dependent_attribute_details?.attr_list?.[entry.attributes[dependent]]
	const uom = dependent ? stage?.uom : (dependent === "" ? entry.default_uom : "")
	entry.default_uom = uom || ""
	entry.uom_hint = uom ? "" : "UOM will be resolved from the Item when saved."
	Object.values(entry.values).filter(Boolean).forEach((cell) => { cell.uom = uom || "" })
}

export function setCellValue(entry, size, field, value) {
	if (!entry.values[size] && !Number(value)) return
	entry.values[size] ||= { qty: 0, rate: 0 }
	Object.assign(entry.values[size], { [field]: Math.max(0, Number(value) || 0), is_prefilled: 1 })
}

export function splitLines(groups) {
	return groups.flatMap((group, groupIndex) => group.items.map((entry, entryIndex) => ({
		label: `${groupIndex + 1}.${entryIndex + 1} ${displayName("Item", entry.name)} ${Object.values(entry.attributes || {}).join(" / ")}`.trim(),
		groupIndex, entryIndex,
	})))
}
