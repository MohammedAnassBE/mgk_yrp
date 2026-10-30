import { computed, ref, watch, onScopeDispose } from "vue"
import { callRead } from "../api/client.js"
import { hasPermission } from "../permissions/usePermissions.js"
import { documentModule } from "./registry.js"

export function usePresentation(doc, itemCount) {
	const extra = ref({})
	const loading = ref(false)
	const error = ref("")
	let sequence = 0
	const module = computed(() => documentModule(doc.value?.doctype))
	const statusRecord = computed(() => doc.value ? { ...doc.value, ...extra.value } : null)
	const summary = computed(() => doc.value ? module.value.summary?.(doc.value, itemCount.value ?? doc.value.items?.length ?? 0) : null)
	const facts = computed(() => doc.value ? module.value.viewFacts?.(statusRecord.value) : null)
	const connections = computed(() => doc.value ? (module.value.connections?.(doc.value) || []).filter((link) => hasPermission(link.doctype)) : [])
	const fieldHints = computed(() => extra.value.fieldHints || {})
	async function load() {
		const current = ++sequence
		const record = doc.value
		extra.value = {}
		error.value = ""
		loading.value = Boolean(record && module.value.loadPresentation)
		if (!loading.value) return
		try {
			const result = await module.value.loadPresentation(record, { read: callRead, can: hasPermission })
			if (current === sequence) extra.value = result
		} catch (cause) { if (current === sequence) error.value = cause.message }
		finally { if (current === sequence) loading.value = false }
	}
	watch(() => [doc.value, doc.value?.supplier, doc.value?.against_purchase_order], load, { immediate: true })
	onScopeDispose(() => { sequence += 1 })
	return { summary, facts, connections, fieldHints, statusRecord, loading, error, retry: load }
}
