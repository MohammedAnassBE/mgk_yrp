import { reactive } from "vue"
import { callRead } from "../api/client.js"

const details = reactive({})
const requested = new Set()

/** Loads the template item and attribute values of item names not seen yet. */
export async function loadItemAttributes(names) {
	const missing = [...new Set(names.filter((name) => name && !requested.has(name)))]
	if (!missing.length) return
	for (const name of missing) requested.add(name)
	try { Object.assign(details, await callRead("mgk_yrp.web.preview.get_item_attributes", { items: missing })) }
	catch (cause) { for (const name of missing) requested.delete(name); throw cause }
}

/** Rows with `item_template` and `item_attributes` from loaded details; values already on a row win. */
export function withItemAttributes(rows) {
	return rows.map((row) => ({ ...details[row.item], ...row }))
}
