<script setup>
import { formatDate } from "../../shared/formatDate.js"
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue"
import ListPageHeader from "../../shell/ListPageHeader.vue"
import NoAccess from "../../shared/NoAccess.vue"
import DateInput from "../../shared/DateInput.vue"
import { callRead } from "../../api/client.js"
import { hasPermission } from "../../permissions/usePermissions.js"
import { subscribeDoctype, onReconnect } from "../../realtime/socket.js"
import { trailingTask } from "../../list/listQuery.js"
import { defaultStockFilters, stockRequest, supplierWarehouses } from "./stockFilters.js"
import "./stock.css"

const canRead = hasPermission("YRP Stock Ledger Entry") && hasPermission("Warehouse")
const filters = reactive(defaultStockFilters())
const options = ref({ suppliers: [], warehouses: [], items: [], received_types: [] })
const result = ref({ rows: [], summary: {} })
const loading = ref(true)
const error = ref("")
const visibleWarehouses = computed(() => supplierWarehouses(options.value, filters.supplier))
const summary = computed(() => result.value.summary)
const quantitySummary = computed(() => Object.entries(summary.value.uom_totals || {}).map(([uom, value]) => `${qty(value)} ${uom}`).join(" · ") || "0")
const pickers = computed(() => [
	{ key: "supplier", label: "Supplier", options: options.value.suppliers, title: options.value.title_fields?.Supplier },
	{ key: "warehouse", label: "Warehouse", options: visibleWarehouses.value, title: options.value.title_fields?.Warehouse },
	{ key: "item", label: "Item", options: options.value.items, title: options.value.title_fields?.Item },
	{ key: "received_type", label: "Received type", options: options.value.received_types },
])
let sequence = 0
let disposers = []
const qty = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })
const money = (value) => Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function supplierChanged() {
	if (!visibleWarehouses.value.some((row) => row.name === filters.warehouse)) filters.warehouse = ""
}
async function load() {
	if (!canRead) return
	const current = ++sequence
	loading.value = true
	error.value = ""
	try {
		const data = await callRead("mgk_yrp.web.stock_note.get_stock_note", stockRequest(filters))
		if (current !== sequence) return
		result.value = data
		options.value = data.options
	} catch (cause) { if (current === sequence) error.value = cause.message }
	finally { if (current === sequence) loading.value = false }
}
const refresh = trailingTask(load, 500)
onMounted(() => {
	if (!canRead) return
	disposers = ["YRP Stock Ledger Entry", "Warehouse", "Supplier", "Item", "YRP Received Type"].map((doctype) => subscribeDoctype(doctype, refresh))
	disposers.push(onReconnect(load))
	load()
})
onBeforeUnmount(() => { sequence++; refresh.cancel(); disposers.forEach((dispose) => dispose()) })
</script>

<template>
	<NoAccess v-if="!canRead" />
	<section v-else class="page list-page stock-note">
		<ListPageHeader title="Stock" />
		<form class="stock-filters" @submit.prevent="load">
			<label><span>From date</span><DateInput v-model="filters.from_date" input-id="stock-from-date" aria-label="From date" required /></label>
			<label><span>To date</span><DateInput v-model="filters.to_date" input-id="stock-to-date" aria-label="To date" required /></label>
			<label v-for="picker in pickers" :key="picker.key">
				<select v-model="filters[picker.key]" :aria-label="picker.label" @change="picker.key === 'supplier' && supplierChanged()">
					<option value="">{{ picker.label }}</option><option v-for="option in picker.options" :key="option.name" :value="option.name">{{ option[picker.title] || option.name }}</option>
				</select>
			</label>
			<button class="button primary" type="submit" :disabled="loading">{{ loading ? 'Loading…' : 'Show stock' }}</button>
		</form>
		<div v-if="error" class="error-state" role="alert"><p>{{ error }}</p><button class="button secondary" @click="load">Retry</button></div>
		<div v-else-if="loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />Loading stock…</div>
		<template v-else>
			<div class="stock-summary">
				<article><span>Stock lines</span><strong>{{ summary.line_count }}</strong></article>
				<article><span>Warehouses</span><strong>{{ summary.warehouse_count }}</strong></article>
				<article><span>Available quantity</span><strong>{{ quantitySummary }}</strong></article>
				<article><span>Stock value</span><strong>{{ money(summary.total_value) }}</strong></article>
			</div>
			<div v-if="!result.rows.length" class="empty-state compact"><i class="pi pi-box" /><h2>No stock found</h2><p>Change the filters or date range and try again.</p></div>
			<div v-else class="stock-table-card">
				<header><h2>Available stock</h2><span>{{ result.rows.length }} lines</span></header>
				<div class="table-scroll"><table>
					<thead><tr><th>Item</th><th>Supplier</th><th>Warehouse</th><th>Received type</th><th class="numeric">Available</th><th class="numeric">Value</th><th>Inward dates</th></tr></thead>
					<tbody><tr v-for="(row, index) in result.rows" :key="index">
						<td><RouterLink v-if="hasPermission('Item')" :to="`/manage/items/${encodeURIComponent(row.item)}`">{{ row.item_name || row.item }}</RouterLink><span v-else>{{ row.item_name || row.item }}</span><small>{{ row.item }}</small></td>
						<td><RouterLink v-if="row.supplier && hasPermission('Supplier')" :to="`/manage/suppliers/${encodeURIComponent(row.supplier)}`">{{ row.supplier_name || row.supplier }}</RouterLink><span v-else>{{ row.supplier_name || row.supplier || 'Company stock' }}</span></td>
						<td><RouterLink v-if="hasPermission('Warehouse')" :to="`/manage/warehouses/${encodeURIComponent(row.warehouse)}`">{{ row.warehouse_name }}</RouterLink><span v-else>{{ row.warehouse_name }}</span></td><td>{{ row.received_type || '—' }}</td>
						<td class="numeric"><strong>{{ qty(row.bal_qty) }}</strong><small>{{ row.stock_uom }}</small></td><td class="numeric">{{ money(row.bal_val) }}</td>
						<td><div v-if="row.inward_date_breakdown?.length" class="inward-list"><span v-for="entry in row.inward_date_breakdown" :key="entry.date"><time>{{ formatDate(entry.date) }}</time><strong>{{ qty(entry.qty) }} {{ row.stock_uom }}</strong></span></div><span v-else>—</span></td>
					</tr></tbody>
				</table></div>
			</div>
		</template>
	</section>
</template>
