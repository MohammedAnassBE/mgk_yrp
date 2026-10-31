<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import Button from "primevue/button"
import ListPageHeader from "../../shell/ListPageHeader.vue"
import NoAccess from "../../shared/NoAccess.vue"
import { formatDate } from "../../shared/formatDate.js"
import { callRead } from "../../api/client.js"
import { canReadBook, hasPermission } from "../../permissions/usePermissions.js"
import { subscribeDoctype, onReconnect } from "../../realtime/socket.js"
import { trailingTask } from "../../list/listQuery.js"
import { money } from "../../documents/previewValues.js"
import MakeBillDialog from "./MakeBillDialog.vue"
import { allChecked, bucketClass, bucketLabel, itemTooltip, keepPending, method, selectedBySupplier, toggleAll, typeLabel } from "./pendingBills.js"
import book from "./config.js"
import "./pendingBills.css"

const BILL_DOCTYPE = "MGK Purchase Invoice"
const canRead = canReadBook(book)
const canBill = hasPermission(BILL_DOCTYPE, "create") && hasPermission(BILL_DOCTYPE, "submit")
const result = ref({ count: 0, suppliers: [] })
const loading = ref(true)
const error = ref("")
const selected = ref(new Set())
const collapsed = ref(new Set())
const dialogOpen = ref(false)
const created = ref([])
const billGroups = ref([])
let sequence = 0
let disposers = []

const allNames = computed(() => result.value.suppliers.flatMap((group) => group.grns.map((grn) => grn.name)))
const supplierNames = (group) => group.grns.map((grn) => grn.name)
const selection = computed(() => selectedBySupplier(result.value.suppliers, selected.value))
const selectedAmount = computed(() => result.value.suppliers.flatMap((group) => group.grns)
	.filter((grn) => selected.value.has(grn.name)).reduce((total, grn) => total + Number(grn.total_amount || 0), 0))

async function load() {
	if (!canRead) return
	const current = ++sequence
	loading.value = true
	error.value = ""
	try {
		const data = await callRead(`${method}.get_pending_bills`)
		if (current !== sequence) return
		result.value = data
		selected.value = keepPending(selected.value, data.suppliers)
	} catch (cause) { if (current === sequence) error.value = cause.message }
	finally { if (current === sequence) loading.value = false }
}
const refresh = trailingTask(load, 500)
function toggle(names, checked) { selected.value = toggleAll(selected.value, names, checked) }
function toggleGroup(supplier) { collapsed.value = toggleAll(collapsed.value, [supplier], !collapsed.value.has(supplier)) }
function openDialog() {
	if (!selection.value.length || dialogOpen.value) return
	created.value = []
	billGroups.value = selection.value
	dialogOpen.value = true
}
function billsCreated(rows) {
	created.value = rows
	selected.value = new Set()
	load()
}
onMounted(() => {
	if (!canRead) return
	disposers = [subscribeDoctype(book.doctype, refresh), subscribeDoctype(BILL_DOCTYPE, refresh), onReconnect(load)]
	load()
})
onBeforeUnmount(() => { sequence++; refresh.cancel(); disposers.forEach((dispose) => dispose()) })
</script>

<template>
	<NoAccess v-if="!canRead" />
	<section v-else class="page list-page pending-bills">
		<ListPageHeader :title="book.label">
			<Button :label="`Make Bill${selected.size ? ` (${selected.size})` : ''}`" :disabled="!canBill || !selected.size || dialogOpen" @click="openDialog" />
		</ListPageHeader>
		<div v-if="created.length" class="pending-created" role="status">
			<strong>Bills created:</strong>
			<RouterLink v-for="row in created" :key="row.name" :to="`/billing/${encodeURIComponent(row.name)}`">{{ row.name }}</RouterLink>
		</div>
		<div class="pending-toolbar">
			<label class="pending-check"><input type="checkbox" :checked="allChecked(selected, allNames)" :disabled="!allNames.length" aria-label="Select all GRNs"
				@change="toggle(allNames, $event.target.checked)"><span>Select all</span></label>
			<span>{{ result.count }} unbilled GRNs · {{ result.suppliers.length }} suppliers</span>
			<span v-if="selected.size" class="pending-selected">{{ selected.size }} selected · {{ money(selectedAmount) }}</span>
		</div>
		<div v-if="error" class="error-state" role="alert"><p>{{ error }}</p><button class="button secondary" @click="load">Retry</button></div>
		<div v-else-if="loading && !result.suppliers.length" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />Loading pending bills…</div>
		<p v-else-if="!result.suppliers.length" class="empty-state compact">Every submitted GRN is billed.</p>
		<article v-for="group in result.suppliers" :key="group.supplier" class="pending-group">
			<header>
				<input type="checkbox" :checked="allChecked(selected, supplierNames(group))" :aria-label="`Select all GRNs of ${group.supplier_name}`"
					@change="toggle(supplierNames(group), $event.target.checked)">
				<button class="pending-toggle" type="button" :aria-expanded="!collapsed.has(group.supplier)" @click="toggleGroup(group.supplier)">
					<i class="pi" :class="collapsed.has(group.supplier) ? 'pi-chevron-right' : 'pi-chevron-down'" aria-hidden="true" /><h2>{{ group.supplier_name }}</h2>
				</button>
				<span class="pending-meta">{{ group.grn_count }} GRNs · {{ money(group.total_amount) }} · {{ group.total_aging }} days</span>
			</header>
			<div v-if="!collapsed.has(group.supplier)" class="table-scroll"><table>
				<thead><tr><th class="check-column"></th><th>GRN</th><th>Date</th><th>Aging</th><th>Type</th><th class="numeric">Qty</th><th class="numeric">Amount</th></tr></thead>
				<tbody>
					<tr v-for="grn in group.grns" :key="grn.name" :title="itemTooltip(grn)">
						<td class="check-column"><input type="checkbox" :checked="selected.has(grn.name)" :aria-label="`Select ${grn.name}`" @change="toggle([grn.name], $event.target.checked)"></td>
						<td><RouterLink :to="`/goods-received-note/${encodeURIComponent(grn.name)}`">{{ grn.name }}</RouterLink></td>
						<td>{{ formatDate(grn.posting_date) }}</td>
						<td><span class="aging-tag" :class="bucketClass[grn.bucket]">{{ bucketLabel(grn.bucket) }}</span> {{ grn.aging }}d</td>
						<td>{{ typeLabel(grn.against) }}</td>
						<td class="numeric">{{ grn.total_qty }}</td>
						<td class="numeric">{{ money(grn.total_amount) }}</td>
					</tr>
				</tbody>
			</table></div>
		</article>
		<MakeBillDialog v-model:visible="dialogOpen" :groups="billGroups" @created="billsCreated" />
	</section>
</template>
