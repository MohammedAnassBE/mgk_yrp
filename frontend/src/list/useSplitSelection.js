import { computed, ref, watch } from "vue"
import { displayName } from "../shell/displayLanguage.js"

export function reconcileSelection(rows, selected, previous = []) {
	if (rows.some((row) => row.name === selected)) return selected
	const index = Math.max(0, previous.findIndex((row) => row.name === selected))
	return rows[Math.min(index, rows.length - 1)]?.name || ""
}

export async function navigateSelection({ rows, selected, direction, hasMore, loadMore }) {
	const current = rows().findIndex((row) => row.name === selected)
	if (direction > 0 && current === rows().length - 1 && hasMore()) await loadMore()
	return rows()[Math.max(0, Math.min(rows().length - 1, current + direction))]?.name || ""
}

export function ignoresNavigation(event, hasDialog = false) {
	return hasDialog || Boolean(event.target?.closest?.("input, select, textarea, button, a, [role='menu'], [role='menuitem'], [contenteditable='true'], [role='dialog'], dialog"))
}

export function recordParty(doctype, row) {
	const supplier = (name) => displayName("Supplier", name) || "—"
	return doctype === "MGK Delivery Challan" ? `${supplier(row.from_location)} → ${supplier(row.to_location)}` : supplier(row.supplier)
}

export function selectionTotals(rows) {
	const amountFields = ["grand_total", "total_amount", "total_declared_value", "total_dc_value", "amount"]
	return {
		hasQuantity: rows.some((row) => (row.total_qty ?? row.total_output_qty) != null),
		quantity: rows.reduce((total, row) => total + Number(row.total_qty ?? row.total_output_qty ?? 0), 0),
		hasAmount: rows.some((row) => amountFields.some((field) => row[field] != null)),
		amount: rows.reduce((total, row) => total + Number(amountFields.map((field) => row[field]).find((value) => value != null) ?? 0), 0),
	}
}

export function useSplitSelection(rows, queryKey) {
	const names = ref([])
	const selectedRows = computed(() => rows().filter((row) => names.value.includes(row.name)))
	const allSelected = computed(() => rows().length > 0 && selectedRows.value.length === rows().length)
	const clear = () => { names.value = [] }
	function toggle(name) {
		names.value = names.value.includes(name) ? names.value.filter((value) => value !== name) : [...names.value, name]
	}
	function toggleAll() { names.value = allSelected.value ? [] : rows().map((row) => row.name) }
	watch(rows, (values) => { names.value = names.value.filter((name) => values.some((row) => row.name === name)) })
	watch(queryKey, clear)
	return { names, selectedRows, allSelected, clear, toggle, toggleAll }
}
