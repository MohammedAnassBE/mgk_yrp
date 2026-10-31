import { formatDate } from "../shared/formatDate.js"
import { computed, onScopeDispose, ref, watch } from "vue"
import { callMethod } from "../api/client.js"
import { trailingTask } from "../list/listQuery.js"
import { formatFieldValue } from "../document/fieldDisplay.js"

export const lastRateMethod = "mgk_yrp.purchase.last_rate.get_last_purchase_rates"

export function lastRateText(history) {
	if (!history) return ""
	const date = history.po_date ? ` · ${formatDate(history.po_date)}` : ""
	return `Last: ₹${formatFieldValue({ fieldtype: "Currency" }, history.rate)} · ${history.purchase_order}${date}`
}

export function lastRateSignature(groups) {
	return JSON.stringify(groups.map((group) => ({ primary: group.primary_attribute || "", items: group.items.map((entry) => ({
		name: entry.name, attributes: entry.attributes || {}, keys: Object.keys(entry.values || {}).filter((key) => entry.values[key]) })) })))
}

export function useLastRates({ groups, supplier, currentDocument, enabled }) {
	const rates = ref({})
	const signature = computed(() => enabled() && supplier() ? `${supplier()}|${currentDocument() || ""}|${lastRateSignature(groups.value)}` : "")
	let sequence = 0
	async function load() {
		const current = ++sequence
		if (!signature.value || !groups.value.length) { rates.value = {}; return }
		try {
			const result = await callMethod(lastRateMethod, { item_details: JSON.stringify(groups.value), supplier: supplier(),
				current_purchase_order: currentDocument() || null })
			if (current === sequence) rates.value = result || {}
		} catch { if (current === sequence) rates.value = {} }
	}
	const delayedLoad = trailingTask(load, 300)
	watch(signature, (value) => {
		sequence += 1
		if (!value) { delayedLoad.cancel(); rates.value = {}; return }
		delayedLoad()
	}, { immediate: true })
	onScopeDispose(() => { sequence += 1; delayedLoad.cancel() })
	const hint = (groupIndex, entryIndex, key) => lastRateText(rates.value[`${groupIndex}:${entryIndex}:${key}`])
	return { rates, hint }
}
