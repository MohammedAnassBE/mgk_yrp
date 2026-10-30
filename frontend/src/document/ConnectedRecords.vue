<script setup>
import { ref, watch, onScopeDispose } from "vue"
import { getCounts } from "../api/client.js"
const props = defineProps({ connections: Array, record: Object })
const counts = ref([])
const error = ref("")
const loading = ref(false)
let sequence = 0
async function load() {
	const current = ++sequence
	error.value = ""
	counts.value = []
	loading.value = Boolean(props.connections.length)
	if (!loading.value) return
	try {
		const result = await getCounts(props.connections.map(({ doctype, filters }) => ({ doctype, filters })))
		if (current === sequence) counts.value = result
	} catch (cause) { if (current === sequence) error.value = cause.message }
	finally { if (current === sequence) loading.value = false }
}
watch(() => [props.record, props.connections], load, { immediate: true })
onScopeDispose(() => { sequence += 1 })
</script>
<template>
	<div v-if="connections.length">
		<p v-if="loading" role="status">Loading connected records…</p>
		<div v-else-if="error" class="error-state" role="alert">
			{{ error }} <button type="button" class="button secondary small" @click="load">Retry</button>
		</div>
		<RouterLink v-else v-for="(link, index) in connections" :key="link.doctype" :to="link.to" class="connected-record">
			<small>Connected records</small><strong>{{ link.label }} <b>{{ counts[index] ?? 0 }}</b> ›</strong>
		</RouterLink>
	</div>
</template>
