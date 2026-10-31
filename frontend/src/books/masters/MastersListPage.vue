<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue"
import ListPageHeader from "../../shell/ListPageHeader.vue"
import NoAccess from "../../shared/NoAccess.vue"
import { readableMasters } from "../../permissions/usePermissions.js"
import { getCounts } from "../../api/client.js"
import { subscribeDoctype, onReconnect } from "../../realtime/socket.js"
import { trailingTask } from "../../list/listQuery.js"
import "../../masters/masters.css"

const masters = readableMasters()
const counts = ref([])
const loading = ref(true)
const error = ref("")
let sequence = 0
let disposers = []
async function load() {
	const current = ++sequence
	loading.value = true
	error.value = ""
	try {
		const values = await getCounts(masters.map((master) => ({ doctype: master.doctype, filters: master.baseFilters || [], or_filters: master.baseOrFilters || [] })))
		if (current === sequence) counts.value = values
	} catch (cause) { if (current === sequence) error.value = cause.message }
	finally { if (current === sequence) loading.value = false }
}
const refresh = trailingTask(load, 500)
onMounted(() => { disposers = masters.map((master) => subscribeDoctype(master.doctype, refresh)); disposers.push(onReconnect(load)); if (masters.length) load() })
onBeforeUnmount(() => { sequence++; refresh.cancel(); disposers.forEach((dispose) => dispose()) })
</script>

<template>
	<NoAccess v-if="!masters.length" />
	<section v-else class="page list-page">
		<ListPageHeader title="Manage" />
		<div v-if="error" class="error-state" role="alert"><p>{{ error }}</p><button class="button secondary" @click="load">Retry</button></div>
		<div v-if="loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />Loading masters…</div>
		<div v-else class="manage-grid">
			<RouterLink v-for="(master, index) in masters" :key="master.key" class="manage-card" :to="master.route">
				<strong>{{ master.label }}</strong><div class="manage-foot"><span>{{ error ? 'Count unavailable' : `${counts[index] || 0} records` }}</span><b>Manage ›</b></div>
			</RouterLink>
		</div>
	</section>
</template>
