<script setup>
import { t } from "../../shell/terminology.js"
import { attributeValueName, displayName } from "../../shell/displayLanguage.js"
import { itemAttributeNames, templateName } from "../../documents/previewValues.js"
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
const attributes = computed(() => itemAttributeNames(result.value.rows))
const quantitySummary = computed(() => Object.entries(summary.value.uom_totals || {}).map(([uom, value]) => `${qty(value)} ${uom}`).join(" · ") || "0")
const pickers = computed(() => [
	{ key: "supplier", label: "Supplier", doctype: "Supplier", options: options.value.suppliers, title: options.value.title_fields?.Supplier },
	{ key: "warehouse", label: "Warehouse", doctype: "Warehouse", options: visibleWarehouses.value, title: options.value.title_fields?.Warehouse },
	{ key: "item", label: "Item", doctype: "Item", options: options.value.items, title: options.value.title_fields?.Item },
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
		<ListPageHeader :title="t('Stock')" />
		<form class="stock-filters" @submit.prevent="load">
			<label><span>{{ t("From date") }}</span><DateInput v-model="filters.from_date" input-id="stock-from-date" :aria-label="t('From date')" required /></label>
			<label><span>{{ t("To date") }}</span><DateInput v-model="filters.to_date" input-id="stock-to-date" :aria-label="t('To date')" required /></label>
			<label v-for="picker in pickers" :key="picker.key">
				<select v-model="filters[picker.key]" :aria-label="t(picker.label)" @change="picker.key === 'supplier' && supplierChanged()">
					<option value="">{{ t(picker.label) }}</option><option v-for="option in picker.options" :key="option.name" :value="option.name">{{ picker.doctype ? displayName(picker.doctype, option.name, option[picker.title] || option.name) : option[picker.title] || option.name }}</option>
				</select>
			</label>
			<button class="button primary" type="submit" :disabled="loading">{{ t(loading ? 'Loading…' : 'Show stock') }}</button>
		</form>
		<div v-if="error" class="error-state" role="alert"><p>{{ error }}</p><button class="button secondary" @click="load">{{ t("Retry") }}</button></div>
		<div v-else-if="loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />{{ t("Loading stock…") }}</div>
		<template v-else>
			<div class="stock-summary">
				<article><span>{{ t("Stock lines") }}</span><strong>{{ summary.line_count }}</strong></article>
				<article><span>{{ t("Warehouses") }}</span><strong>{{ summary.warehouse_count }}</strong></article>
				<article><span>{{ t("Available quantity") }}</span><strong>{{ quantitySummary }}</strong></article>
				<article><span>{{ t("Stock value") }}</span><strong>{{ money(summary.total_value) }}</strong></article>
			</div>
			<div v-if="!result.rows.length" class="empty-state compact"><i class="pi pi-box" /><h2>{{ t("No stock found") }}</h2><p>{{ t("Change the filters or date range and try again.") }}</p></div>
			<div v-else class="stock-table-card">
				<header><h2>{{ t("Available stock") }}</h2><span>{{ result.rows.length }} {{ t("lines") }}</span></header>
				<div class="table-scroll"><table>
					<thead><tr><th>{{ t("Item") }}</th><th v-for="attribute in attributes" :key="attribute">{{ t(attribute) }}</th><th>{{ t("Supplier") }}</th><th>{{ t("Warehouse") }}</th><th>{{ t("Received type") }}</th><th class="numeric">{{ t("Available") }}</th><th class="numeric">{{ t("Value") }}</th><th>{{ t("Inward dates") }}</th></tr></thead>
					<tbody><tr v-for="(row, index) in result.rows" :key="index">
						<td><RouterLink v-if="hasPermission('Item')" :to="`/manage/items/${encodeURIComponent(row.item)}`">{{ templateName(row) }}</RouterLink><span v-else>{{ templateName(row) }}</span><small>{{ row.item_template || row.item }}</small></td>
						<td v-for="attribute in attributes" :key="attribute">{{ attributeValueName(attribute, row.item_attributes?.[attribute]) || '—' }}</td>
						<td><RouterLink v-if="row.supplier && hasPermission('Supplier')" :to="`/manage/suppliers/${encodeURIComponent(row.supplier)}`">{{ displayName('Supplier', row.supplier, row.supplier_name || row.supplier) }}</RouterLink><span v-else>{{ displayName('Supplier', row.supplier, row.supplier_name || row.supplier) || t('Company stock') }}</span></td>
						<td><RouterLink v-if="hasPermission('Warehouse')" :to="`/manage/warehouses/${encodeURIComponent(row.warehouse)}`">{{ displayName('Warehouse', row.warehouse, row.warehouse_name) }}</RouterLink><span v-else>{{ displayName('Warehouse', row.warehouse, row.warehouse_name) }}</span></td><td>{{ row.received_type || '—' }}</td>
						<td class="numeric"><strong>{{ qty(row.bal_qty) }}</strong><small>{{ row.stock_uom }}</small></td><td class="numeric">{{ money(row.bal_val) }}</td>
						<td><div v-if="row.inward_date_breakdown?.length" class="inward-list"><span v-for="entry in row.inward_date_breakdown" :key="entry.date"><time>{{ formatDate(entry.date) }}</time><strong>{{ qty(entry.qty) }} {{ row.stock_uom }}</strong></span></div><span v-else>—</span></td>
					</tr></tbody>
				</table></div>
			</div>
		</template>
	</section>
</template>
