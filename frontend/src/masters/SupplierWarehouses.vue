<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { callRead } from "../api/client.js"
import { hasPermission } from "../permissions/usePermissions.js"
import { subscribeDoctype, onReconnect } from "../realtime/socket.js"
import { trailingTask } from "../list/listQuery.js"
import { stageNewDefaults } from "../list/listState.js"
import { partyReturnPath, supplierWarehouseDraft } from "./masterFields.js"
import { getMaster } from "./mastersConfig.js"

const props = defineProps({ doc: Object, modified: String, step: Number, blocked: Boolean })
const router = useRouter()
const warehouses = getMaster("warehouses")
const rows = ref([])
const loading = ref(true)
const error = ref("")
let sequence = 0
let disposers = []
const supplierPath = () => partyReturnPath(getMaster("suppliers"), props.doc.name)
async function load() {
	const current = ++sequence
	loading.value = true
	error.value = ""
	try {
		const result = await callRead("frappe.client.get_list", { doctype: "Warehouse", fields: ["name", "warehouse_name", "is_group", "disabled"],
			filters: { supplier: props.doc.name }, order_by: "name asc", limit_page_length: 0 })
		if (current === sequence) rows.value = result
	} catch (cause) { if (current === sequence) error.value = cause.message }
	finally { if (current === sequence) loading.value = false }
}
async function open(name) {
	if (props.blocked) { error.value = "Save the supplier before opening a warehouse."; return }
	try {
		const query = { returnTo: supplierPath() }
		if (!name) {
			const companies = await callRead("frappe.client.get_list", { doctype: "Company", fields: ["name"], limit_page_length: 2 })
			query.defaults = stageNewDefaults("Warehouse", supplierWarehouseDraft(props.doc, companies), supplierPath())
		}
		await router.push({ path: `${warehouses.route}/${name ? encodeURIComponent(name) : "new"}`, query })
	} catch (cause) { error.value = cause.message }
}
const refresh = trailingTask(load, 500)
watch(() => props.modified, refresh)
onMounted(() => { disposers = [subscribeDoctype("Warehouse", refresh), onReconnect(load)]; load() })
onBeforeUnmount(() => { sequence++; refresh.cancel(); disposers.forEach((dispose) => dispose()) })
</script>

<template>
	<section class="form-section">
		<header class="mgk-card__head"><span class="book-step">{{ step }}</span><h2>Warehouses</h2></header>
		<div class="master-party-body">
			<div v-if="loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />Loading warehouses…</div>
			<div v-else-if="error" class="error-state" role="alert"><p>{{ error }}</p><button class="button secondary" @click="load">Retry</button></div>
			<section v-else>
				<div class="manage-foot"><h3>Supplier warehouses</h3><button v-if="hasPermission('Warehouse', 'create')" class="button secondary small" :disabled="blocked" @click="open()">Create Warehouse</button></div>
				<p v-if="!rows.length" class="field-help">No warehouses linked to this supplier yet.</p>
				<div v-for="row in rows" :key="row.name" class="master-party-row"><a :href="`/web${warehouses.route}/${encodeURIComponent(row.name)}`" @click.prevent="open(row.name)">{{ row.warehouse_name || row.name }} ›</a><p>{{ [row.is_group ? 'Group' : '', row.disabled ? 'Disabled' : ''].filter(Boolean).join(' · ') }}</p></div>
			</section>
		</div>
	</section>
</template>
