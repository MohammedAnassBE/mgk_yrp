<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue"
import ListPageHeader from "../../shell/ListPageHeader.vue"
import NoAccess from "../../shared/NoAccess.vue"
import DateInput from "../../shared/DateInput.vue"
import LinkInput from "../../list/LinkInput.vue"
import { formatDate } from "../../shared/formatDate.js"
import { callRead } from "../../api/client.js"
import { hasPermission } from "../../permissions/usePermissions.js"
import { subscribeDoctype, onReconnect } from "../../realtime/socket.js"
import { trailingTask } from "../../list/listQuery.js"
import book from "./config.js"
import "./paymentLedger.css"

const BILL_DOCTYPE = "MGK Purchase Invoice"
const canRead = hasPermission(book.doctype)
const filters = reactive({ supplier: "", from_date: "", to_date: "" })
const appliedSupplier = ref("")
const shown = ref({ supplier: "", from_date: "" })
const result = ref({ rows: [], suppliers: [], totals: {}, opening_balance: 0 })
const loading = ref(true)
const error = ref("")
const suppliersOpen = ref(false)
const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value) || 0)
let sequence = 0
let disposers = []

async function load() {
	if (!canRead) return
	const current = ++sequence
	const params = { ...filters, supplier: appliedSupplier.value }
	loading.value = true
	error.value = ""
	try {
		const data = await callRead("mgk_yrp.web.payment_ledger.get_payment_ledger", params)
		if (current !== sequence) return
		result.value = data
		shown.value = { supplier: params.supplier, from_date: params.from_date }
	} catch (cause) { if (current === sequence) error.value = cause.message }
	finally { if (current === sequence) loading.value = false }
}
function applySupplier(supplier) {
	filters.supplier = supplier
	appliedSupplier.value = supplier
}
const entryTypeLabel = (row) => row.type === "Bill" ? "Bill" : row.entry_type || (row.credit ? "Credit" : "Debit")
const entryTypeClass = (row) => ({ bill: row.type === "Bill", debit: row.type !== "Bill" && entryTypeLabel(row) === "Debit" })
const refresh = trailingTask(load, 500)
const documentLink = (row) => `${row.type === "Bill" ? "/billing" : "/supplier-credit-debit"}/${encodeURIComponent(row.name)}`
watch(() => [filters.from_date, filters.to_date, appliedSupplier.value], load)
watch(() => filters.supplier, (supplier) => { if (!supplier) appliedSupplier.value = "" })
onMounted(() => {
	if (!canRead) return
	disposers = [subscribeDoctype(book.doctype, refresh), subscribeDoctype(BILL_DOCTYPE, refresh), onReconnect(load)]
	load()
})
onBeforeUnmount(() => { sequence++; refresh.cancel(); disposers.forEach((dispose) => dispose()) })
</script>

<template>
	<NoAccess v-if="!canRead" />
	<section v-else class="page list-page payment-ledger">
		<ListPageHeader :title="book.label" />
		<form class="ledger-filters" @submit.prevent="load">
			<label><span>Supplier</span><LinkInput v-model="filters.supplier" doctype="Supplier" label="Supplier" input-id="ledger-supplier" placeholder="All suppliers" @select="applySupplier" /></label>
			<label><span>From date</span><DateInput v-model="filters.from_date" input-id="ledger-from-date" aria-label="From date" /></label>
			<label><span>To date</span><DateInput v-model="filters.to_date" input-id="ledger-to-date" aria-label="To date" /></label>
			<button class="button primary" type="submit" :disabled="loading">{{ loading ? 'Loading…' : 'Show ledger' }}</button>
		</form>
		<div v-if="error" class="error-state" role="alert"><p>{{ error }}</p><button class="button secondary" @click="load">Retry</button></div>
		<div v-else-if="loading && !result.rows.length" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />Loading ledger…</div>
		<template v-else>
			<div class="ledger-summary">
				<article><span>Total Credit</span><strong>{{ money(result.totals.credit) }}</strong></article>
				<article><span>Total Debit</span><strong>{{ money(result.totals.debit) }}</strong></article>
				<article><span>Balance</span><strong>{{ money(result.totals.balance) }}</strong></article>
			</div>
			<div class="ledger-table-card">
				<header><h2>Ledger entries</h2><span>{{ result.rows.length }} entries</span></header>
				<div class="table-scroll"><table>
					<thead><tr><th>Date</th><th>Supplier</th><th>Type</th><th>Document</th><th>Reason</th><th class="numeric">Credit</th><th class="numeric">Debit</th><th class="numeric">{{ shown.supplier ? 'Balance' : 'Supplier running balance' }}</th></tr></thead>
					<tbody>
						<tr v-if="shown.from_date" class="ledger-opening"><td>{{ formatDate(shown.from_date) }}</td><td colspan="6">Opening balance{{ shown.supplier ? '' : ' (all suppliers)' }}</td><td class="numeric"><strong>{{ money(result.opening_balance) }}</strong></td></tr>
						<tr v-for="row in result.rows" :key="`${row.type}:${row.name}`">
							<td>{{ formatDate(row.date) }}</td>
							<td>{{ row.supplier_name || row.supplier }}</td>
							<td><span class="ledger-type" :class="entryTypeClass(row)">{{ entryTypeLabel(row) }}</span></td>
							<td><RouterLink :to="documentLink(row)">{{ row.name }}</RouterLink></td>
							<td>{{ row.reason }}</td>
							<td class="numeric">{{ row.credit ? money(row.credit) : '—' }}</td><td class="numeric">{{ row.debit ? money(row.debit) : '—' }}</td>
							<td class="numeric"><strong>{{ money(row.balance) }}</strong></td>
						</tr>
						<tr v-if="!result.rows.length"><td colspan="8" class="ledger-empty">No entries in this period.</td></tr>
					</tbody>
					<tfoot><tr class="ledger-total"><td colspan="5">Total</td><td class="numeric">{{ money(result.totals.credit) }}</td><td class="numeric">{{ money(result.totals.debit) }}</td><td class="numeric">{{ money(result.totals.balance) }}</td></tr></tfoot>
				</table></div>
			</div>
			<div class="ledger-table-card ledger-suppliers">
				<header>
					<button class="ledger-toggle" type="button" :aria-expanded="suppliersOpen" @click="suppliersOpen = !suppliersOpen">
						<i class="pi" :class="suppliersOpen ? 'pi-chevron-down' : 'pi-chevron-right'" aria-hidden="true" /><h2>Supplier balances</h2>
					</button>
					<span>{{ result.suppliers.length }} suppliers</span>
				</header>
				<div v-if="suppliersOpen" class="table-scroll"><table>
					<thead><tr><th>Supplier</th><th class="numeric">Credit</th><th class="numeric">Debit</th><th class="numeric">Balance</th></tr></thead>
					<tbody>
						<tr v-for="row in result.suppliers" :key="row.supplier">
							<td><button class="ledger-link" type="button" @click="applySupplier(row.supplier)">{{ row.supplier_name }}</button></td>
							<td class="numeric">{{ money(row.credit) }}</td><td class="numeric">{{ money(row.debit) }}</td><td class="numeric"><strong>{{ money(row.balance) }}</strong></td>
						</tr>
						<tr v-if="!result.suppliers.length"><td colspan="4" class="ledger-empty">No suppliers in this period.</td></tr>
					</tbody>
				</table></div>
			</div>
		</template>
	</section>
</template>
