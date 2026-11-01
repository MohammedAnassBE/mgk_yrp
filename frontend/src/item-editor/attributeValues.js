import { callMethod } from "../api/client.js"
import { notify } from "../shared/notify.js"

export const ATTRIBUTE_VALUE = "YRP Item Attribute Value"

export async function createAttributeValue(item, doc, call = callMethod) {
	const value = await call("mgk_yrp.stock.attribute_values.create_attribute_value", { item, attribute: doc.attribute_name, value: doc.attribute_value })
	notify.success(`${value} added to ${doc.attribute_name}`)
	return value
}

export function attributeLinkProps(item, attribute) {
	return { searchMethod: "yrp.yrp.doctype.yrp_item.yrp_item.search_item_attribute_values", searchArgs: { item, attribute },
		createDoctype: ATTRIBUTE_VALUE, createDefaults: { attribute_name: attribute }, createWith: (doc) => createAttributeValue(item, doc) }
}
