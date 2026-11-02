import { callMethod } from "../api/client.js"
import { notify } from "../shared/notify.js"
import { ATTRIBUTE_VALUE, attributeValueName, forgetAttributeValue } from "../shell/displayLanguage.js"

export async function createAttributeValue(item, doc, call = callMethod) {
	const tamil = String(doc.mgk_tamil_name || "").trim()
	const value = await call("mgk_yrp.stock.attribute_values.create_attribute_value", { item, attribute: doc.attribute_name,
		value: doc.attribute_value, ...(tamil ? { tamil_name: tamil } : {}) })
	forgetAttributeValue(doc.attribute_name, value)
	notify.success(`${value} added to ${doc.attribute_name}`)
	return value
}

export function attributeLinkProps(item, attribute) {
	return { searchMethod: "mgk_yrp.stock.attribute_values.search_item_attribute_values", searchArgs: { item, attribute },
		displayValue: (value) => attributeValueName(attribute, value),
		createDoctype: ATTRIBUTE_VALUE, createDefaults: { attribute_name: attribute }, createWith: (doc) => createAttributeValue(item, doc) }
}

export function defaultAttributes(details) {
	const defaults = details.attribute_defaults || {}
	return Object.fromEntries((details.attributes || []).filter((attribute) => attribute !== details.primary_attribute && defaults[attribute])
		.map((attribute) => [attribute, defaults[attribute]]))
}
