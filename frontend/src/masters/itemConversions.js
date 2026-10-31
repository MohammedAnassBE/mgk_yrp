import { callRead } from "../api/client.js"

export function isProcessConversion(parent, field) {
	return parent?.doctype === "Item" && field.fieldname === "mgk_process_conversions"
}

export function conversionDefaults(parent) {
	return { from_uom: parent.stock_uom, from_qty: 1 }
}

export async function conversionOutputUom(item) {
	if (!item) return null
	const output = await callRead("frappe.client.get_value", { doctype: "Item", filters: { name: item }, fieldname: "stock_uom" })
	return output.stock_uom
}

export function derivedItemValues(name, value, isNew) {
	if (name === "attributes") return { has_variants: value?.length ? 1 : 0 }
	if (name === "item_name" && isNew) return { item_code: value }
	return {}
}
