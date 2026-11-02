<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import Menu from "primevue/menu"
import { documentModule } from "../documents/registry.js"
import { connectedDocuments } from "../document/documentLayout.js"
import { bookManifest } from "../books/manifest.js"
import { formatDisplayDatetime } from "../document/activityFormat.js"
import { columnTotals, isAmountFact, remainingConnections, rows, visibleFacts, withAttributeColumns } from "../documents/previewValues.js"
import { previewActions } from "./previewActions.js"
import { useActionRunner } from "../document/useActionRunner.js"
import ActionHost from "../document/ActionHost.vue"
import { hasPermission } from "../permissions/usePermissions.js"
import { hasOpenDialog, isSaveShortcut } from "../document/lifecycle.js"
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
	refresh: { type: Function, required: true },
})
const loader = usePreview()
const state = loader.state
const preview = computed(() => state.preview)
const presentation = computed(() => documentModule(props.doctype).preview)
const doc = computed(() => preview.value?.doc)
const facts = computed(() => visibleFacts(doc.value ? presentation.value?.facts(doc.value, preview.value) || [] : []))
const itemRows = computed(() => preview.value ? presentation.value?.itemRows(preview.value) || [] : [])
const itemColumns = computed(() => withAttributeColumns((presentation.value?.itemColumns || []).filter((column) => !column.internalOnly || Number(doc.value?.is_internal_transfer)),
	rows(preview.value)))
const planColumns = computed(() => withAttributeColumns(presentation.value?.planColumns || [], preview.value?.extra?.plan_rows))
const planRows = computed(() => preview.value ? presentation.value?.planRows?.(preview.value) || [] : [])
const progress = computed(() => doc.value ? presentation.value?.progress?.(doc.value, preview.value) : null)
const intro = computed(() => preview.value ? presentation.value?.intro?.(preview.value) : null)
const totals = computed(() => columnTotals(itemColumns.value, itemRows.value))
const bookStyle = computed(() => ({ "--preview-book": `var(--${bookManifest.find((book) => book.doctype === props.doctype)?.cover || "cover-masters"})` }))
const timelineLabel = computed(() => {
	const count = preview.value?.timeline?.length
	const label = `${is_timeline_open.value ? "▾" : "▸"} Timeline`
	return count ? `${label} · ${count} event${count === 1 ? "" : "s"}` : label
})
const connections = computed(() => remainingConnections(preview.value?.connections, facts.value, itemColumns.value, itemRows.value))
const actions = computed(() => doc.value ? previewActions({ ...doc.value, doctype: props.doctype }, preview.value, hasPermission) : [])
const menu = ref(null)
const is_timeline_open = ref(false)
const timelineId = computed(() => `preview-timeline-${encodeURIComponent(props.doctype)}-${encodeURIComponent(props.row?.name || "")}`)
const runner = useActionRunner({ reload, settled: actionSettled })
const menuItems = computed(() => actions.value.map((action) => ({ label: action.label,
	disabled: runner.busy.value, command: () => runner.run(action, { doc: { ...doc.value, doctype: props.doctype } }) })))
let unsubscribe = () => {}
let listDisposers = []
let has_pending_refresh = false

function reload() {
	if (!props.row) return
	has_pending_refresh = false
	liveReload.cancel()
	invalidateReads()
	return loader.loadPreview(props.doctype, props.row.name, { modified: props.row.modified, immediate: true, force: true })
}
function actionSettled({ doc }) {
	loader.invalidate(doc.doctype, doc.name)
	return props.refresh()
}
const liveReload = trailingTask(reload, 300)
function updated() {
	if (!props.row) { loader.clear(); return }
	loader.invalidate(props.doctype, props.row.name)
	if (runner.busy.value) { has_pending_refresh = true; liveReload.cancel(); return }
	loader.clear()
	state.loading = true
	liveReload()
}
function listUpdated() { loader.invalidate(); updated() }
const reconnectDispose = onReconnect(listUpdated)

watch(runner.busy, (is_busy) => {
	if (!is_busy && has_pending_refresh) { has_pending_refresh = false; updated() }
})
watch(() => [props.doctype, ...props.relatedDoctypes], (doctypes) => {
	listDisposers.forEach((dispose) => dispose())
	listDisposers = [...new Set(doctypes)].map((doctype) => subscribeDoctype(doctype, listUpdated))
}, { immediate: true })

watch([() => props.doctype, () => props.row?.name], () => {
	is_timeline_open.value = false
	has_pending_refresh = false
	menu.value?.hide()
	runner.reset()
	unsubscribe()
	liveReload.cancel()
	loader.loadPreview(props.doctype, props.row?.name, { modified: props.row?.modified })
	unsubscribe = props.row ? subscribeDoc(props.doctype, props.row.name, updated) : () => {}
}, { immediate: true, flush: "sync" })
watch(() => props.row?.modified, (modified, previous) => {
	if (previous && modified !== previous) updated()
})
function keydown(event) {
	if (!isSaveShortcut(event)) return
	event.preventDefault()
	const submit = actions.value.find((action) => action.key === "submit")
	if (submit && !state.loading && !runner.busy.value && !hasOpenDialog()) runner.run(submit, { doc: { ...doc.value, doctype: props.doctype } })
}
onMounted(() => globalThis.window?.addEventListener?.("keydown", keydown))
onBeforeUnmount(() => { globalThis.window?.removeEventListener?.("keydown", keydown); unsubscribe(); listDisposers.forEach((dispose) => dispose()); reconnectDispose(); liveReload.cancel(); loader.clear() })

function connectionRoute(doctype, name) {
	if (!hasPermission(doctype)) return null
	return connectedDocuments({ linked: name }, { fields: [{ fieldtype: "Link", fieldname: "linked", options: doctype }] })[0]?.to
}
function itemRoute(item, column) {
	const name = item[column.key]
	if (!column.link || !name || name === "—") return null
	const book = bookManifest.find((book) => book.routePath === column.link)
	return book ? connectionRoute(book.doctype, name) : null
}
function cell(value, column) {
	if (value == null || value === "") return "—"
	return column.numeric || column.money ? Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: column.money ? 2 : 0 }) : value
}
</script>

<template>
	<article class="preview-pane list-card" :style="bookStyle" :aria-label="row ? `Preview of ${row.name}` : 'Document preview'">
		<ActionHost :runner="runner" />
		<div v-if="state.loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true" />Loading preview…</div>
		<div v-else-if="state.error" class="error-state" role="alert"><h2>Unable to load preview</h2><p>{{ state.error }}</p><button class="button secondary" type="button" @click="reload">Retry</button></div>
		<div v-else-if="!doc" class="empty-state compact"><h2>Select a document</h2><p>Choose a record to see its preview.</p></div>
		<template v-else>
			<header class="preview-head">
				<div class="preview-title"><div class="preview-title-line"><h2 class="record-id">{{ doc.name }}</h2><span class="status" :class="statusPill(doctype, doc).className">{{ statusPill(doctype, doc).label }}</span></div><p class="split-party"><i class="pi pi-building" aria-hidden="true" />{{ recordParty(doctype, doc) }}</p></div>
				<div class="preview-head-actions"><button v-if="actions.length" class="button secondary" type="button" aria-haspopup="menu" aria-controls="preview-action-menu" :disabled="runner.busy.value" @click="menu.toggle($event)">Actions</button><Menu id="preview-action-menu" ref="menu" :model="menuItems" popup class="preview-action-menu" @keydown.stop /><RouterLink class="button primary" :to="documentRoute(doc.name)" @click="savePosition">Open</RouterLink></div>
			</header>
			<dl class="preview-facts"><div v-for="fact in facts" :key="fact.label" class="preview-fact" :class="{ amount: isAmountFact(fact) }"><dt>{{ fact.label }}</dt><dd><RouterLink v-if="fact.to" :to="fact.to" class="record-id preview-chip">{{ fact.value }}</RouterLink><template v-else>{{ fact.value ?? '—' }}</template></dd></div></dl>
			<div v-if="progress" class="preview-progress"><label>{{ progress.label }}<progress :value="progress.value" :max="progress.max || 1" /></label></div>
			<p v-if="intro" class="form-banner">{{ intro }}</p>
			<section v-if="itemColumns.length"><h3>Items · {{ itemRows.length }}</h3><div class="table-scroll preview-table"><table><thead><tr><th v-for="column in itemColumns" :key="column.key" :class="{ numeric: column.numeric || column.money }">{{ column.label }}</th></tr></thead><tbody><tr v-for="(item, index) in itemRows" :key="item.name || index"><td v-for="column in itemColumns" :key="column.key" :class="{ numeric: column.numeric || column.money }"><RouterLink v-if="itemRoute(item, column)" class="record-id" :to="itemRoute(item, column)">{{ cell(item[column.key], column) }}</RouterLink><template v-else>{{ cell(item[column.key], column) }}</template></td></tr></tbody><tfoot v-if="totals"><tr><td v-for="(column, index) in itemColumns" :key="column.key" :class="{ numeric: column.numeric || column.money }">{{ column.key in totals ? cell(totals[column.key], column) : index === 0 ? 'Total' : '' }}</td></tr></tfoot></table></div><p v-if="!itemRows.length" class="preview-muted">No items.</p></section>
			<section v-if="connections.length"><h3>Connected records</h3><div class="preview-connections"><template v-for="connection in connections" :key="connection.doctype"><template v-for="name in connection.names" :key="name"><RouterLink v-if="connectionRoute(connection.doctype, name)" class="preview-connection" :to="connectionRoute(connection.doctype, name)"><i class="pi pi-link" aria-hidden="true" /><small>{{ connection.label }}</small><span class="record-id">{{ name }}</span></RouterLink><span v-else class="preview-connection"><i class="pi pi-link" aria-hidden="true" /><small>{{ connection.label }}</small><span class="record-id">{{ name }}</span></span></template></template></div></section>
			<section v-if="planRows.length"><h3>Process plan</h3><div class="table-scroll preview-table"><table><thead><tr><th v-for="column in planColumns" :key="column.key">{{ column.label }}</th></tr></thead><tbody><tr v-for="(item, index) in planRows" :key="index"><td v-for="column in planColumns" :key="column.key" :class="{ numeric: column.numeric }">{{ cell(item[column.key], column) }}</td></tr></tbody></table></div></section>
			<section><button class="preview-disclosure" type="button" :aria-expanded="is_timeline_open" :aria-controls="timelineId" @click="is_timeline_open = !is_timeline_open">{{ timelineLabel }}</button><ol :hidden="!is_timeline_open" :id="timelineId" class="preview-timeline"><li v-for="(entry, index) in is_timeline_open ? preview.timeline : []" :key="index"><time>{{ formatDisplayDatetime(entry.at) }}</time><span>{{ entry.text }}</span></li></ol><p v-if="is_timeline_open && !preview.timeline?.length" class="preview-muted">No activity yet.</p></section>
		</template>
	</article>
</template>
