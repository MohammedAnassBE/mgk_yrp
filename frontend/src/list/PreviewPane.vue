<script setup>
import { computed, onBeforeUnmount, watch } from "vue"
import { documentModule } from "../documents/registry.js"
import { connectedDocuments } from "../document/documentLayout.js"
import { formatDisplayDatetime } from "../document/activityFormat.js"
import { forwardActions } from "../document/actionRunner.js"
import { useActionRunner } from "../document/useActionRunner.js"
import ActionHost from "../document/ActionHost.vue"
import { hasPermission } from "../permissions/usePermissions.js"
import { subscribeDoc, subscribeDoctype, onReconnect } from "../realtime/socket.js"
import { invalidateReads } from "../api/client.js"
import { trailingTask } from "./listQuery.js"
import { statusPill } from "./statusPill.js"
import { recordParty } from "./useSplitSelection.js"
import { usePreview } from "./usePreview.js"

const props = defineProps({
	doctype: { type: String, required: true }, row: { type: Object, default: null },
	documentRoute: { type: Function, required: true }, savePosition: { type: Function, required: true },
	relatedDoctypes: { type: Array, default: () => [] },
})
const loader = usePreview()
const state = loader.state
const preview = computed(() => state.preview)
const presentation = computed(() => documentModule(props.doctype).preview)
const doc = computed(() => preview.value?.doc)
const facts = computed(() => doc.value ? presentation.value?.facts(doc.value, preview.value) || [] : [])
const itemRows = computed(() => preview.value ? presentation.value?.itemRows(preview.value) || [] : [])
const itemColumns = computed(() => (presentation.value?.itemColumns || []).filter((column) => !column.internalOnly || Number(doc.value?.is_internal_transfer)))
const planRows = computed(() => preview.value ? presentation.value?.planRows?.(preview.value) || [] : [])
const progress = computed(() => doc.value ? presentation.value?.progress?.(doc.value, preview.value) : null)
const intro = computed(() => preview.value ? presentation.value?.intro?.(preview.value) : null)
const actions = computed(() => doc.value ? forwardActions(documentModule(props.doctype).actions?.(doc.value, hasPermission) || []) : [])
const runner = useActionRunner({ reload })
let unsubscribe = () => {}
let listDisposers = []

function reload() {
	if (!props.row) return
	invalidateReads()
	return loader.loadPreview(props.doctype, props.row.name, { modified: props.row.modified, immediate: true, force: true })
}
const liveReload = trailingTask(reload, 300)
function updated() {
	if (!props.row) { loader.clear(); return }
	loader.invalidate(props.doctype, props.row.name)
	loader.clear()
	state.loading = true
	liveReload()
}
function listUpdated() { loader.invalidate(); updated() }
const reconnectDispose = onReconnect(listUpdated)

watch(() => [props.doctype, ...props.relatedDoctypes], (doctypes) => {
	listDisposers.forEach((dispose) => dispose())
	listDisposers = [...new Set(doctypes)].map((doctype) => subscribeDoctype(doctype, listUpdated))
}, { immediate: true })

watch(() => [props.doctype, props.row?.name], () => {
	runner.reset()
	unsubscribe()
	liveReload.cancel()
	loader.loadPreview(props.doctype, props.row?.name, { modified: props.row?.modified })
	unsubscribe = props.row ? subscribeDoc(props.doctype, props.row.name, updated) : () => {}
}, { immediate: true, flush: "sync" })
watch(() => props.row?.modified, (modified, previous) => {
	if (previous && modified !== previous) updated()
})
onBeforeUnmount(() => { unsubscribe(); listDisposers.forEach((dispose) => dispose()); reconnectDispose(); liveReload.cancel(); loader.clear() })

function connectionRoute(doctype, name) {
	if (!hasPermission(doctype)) return null
	return connectedDocuments({ linked: name }, { fields: [{ fieldtype: "Link", fieldname: "linked", options: doctype }] })[0]?.to
}
function cell(value, column) {
	if (value == null || value === "") return "—"
	return column.numeric || column.money ? Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: column.money ? 2 : 0 }) : value
}
</script>

<template>
	<article class="preview-pane list-card" :aria-label="row ? `Preview of ${row.name}` : 'Document preview'">
		<div v-if="state.loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true" />Loading preview…</div>
		<div v-else-if="state.error" class="error-state" role="alert"><h2>Unable to load preview</h2><p>{{ state.error }}</p><button class="button secondary" type="button" @click="reload">Retry</button></div>
		<div v-else-if="!doc" class="empty-state compact"><h2>Select a document</h2><p>Choose a record to see its preview.</p></div>
		<template v-else>
			<header class="preview-head"><h2 class="record-id">{{ doc.name }}</h2><span class="status" :class="statusPill(doctype, doc).className">{{ statusPill(doctype, doc).label }}</span><RouterLink class="button secondary" :to="documentRoute(doc.name)" @click="savePosition">Open</RouterLink></header>
			<p class="split-party">{{ recordParty(doctype, doc) }}</p>
			<div v-if="actions.length" class="preview-actions"><button v-for="action in actions" :key="action.key" class="button secondary" type="button" :disabled="runner.busy.value" @click="runner.run(action, { doc })">{{ action.label }}</button></div>
			<ActionHost :runner="runner" />
			<dl class="preview-facts"><div v-for="fact in facts" :key="fact.label"><dt>{{ fact.label }}</dt><dd><RouterLink v-if="fact.to" :to="fact.to" class="record-id">{{ fact.value }}</RouterLink><template v-else>{{ fact.value ?? '—' }}</template></dd></div></dl>
			<div v-if="progress" class="preview-progress"><label>{{ progress.label }}<progress :value="progress.value" :max="progress.max || 1" /></label></div>
			<p v-if="intro" class="form-banner">{{ intro }}</p>
			<section><h3>Items</h3><div class="table-scroll"><table><thead><tr><th v-for="column in itemColumns" :key="column.key" :class="{ numeric: column.numeric || column.money }">{{ column.label }}</th></tr></thead><tbody><tr v-for="(item, index) in itemRows" :key="item.name || index"><td v-for="column in itemColumns" :key="column.key" :class="{ numeric: column.numeric || column.money }">{{ cell(item[column.key], column) }}</td></tr></tbody></table></div><p v-if="!itemRows.length" class="preview-muted">No items.</p></section>
			<section><h3>Connected records</h3><div v-for="connection in preview.connections" :key="connection.doctype" class="preview-connection"><strong>{{ connection.label }}</strong><span v-for="name in connection.names" :key="name"><RouterLink v-if="connectionRoute(connection.doctype, name)" class="record-id" :to="connectionRoute(connection.doctype, name)">{{ name }}</RouterLink><template v-else>{{ name }}</template></span></div><p v-if="!preview.connections?.length" class="preview-muted">Nothing linked yet.</p></section>
			<section v-if="planRows.length"><h3>Process plan</h3><div class="table-scroll"><table><thead><tr><th v-for="column in presentation.planColumns" :key="column.key">{{ column.label }}</th></tr></thead><tbody><tr v-for="(item, index) in planRows" :key="index"><td v-for="column in presentation.planColumns" :key="column.key" :class="{ numeric: column.numeric }">{{ cell(item[column.key], column) }}</td></tr></tbody></table></div></section>
			<section><h3>Timeline</h3><ol class="preview-timeline"><li v-for="(entry, index) in preview.timeline" :key="index"><time>{{ formatDisplayDatetime(entry.at) }}</time><span>{{ entry.text }}</span></li></ol><p v-if="!preview.timeline?.length" class="preview-muted">No activity yet.</p></section>
		</template>
	</article>
</template>
