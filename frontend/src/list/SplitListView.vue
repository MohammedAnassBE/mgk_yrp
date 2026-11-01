<script setup>
import { formatDate } from "../shared/formatDate.js"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import PreviewPane from "./PreviewPane.vue"
import SelectionSummary from "./SelectionSummary.vue"
import { ignoresNavigation, navigateSelection, reconcileSelection, recordParty, useSplitSelection } from "./useSplitSelection.js"
import { statusPill } from "./statusPill.js"
import "./split.css"

const props = defineProps({
	doctype: { type: String, required: true }, rows: { type: Array, required: true },
	columns: { type: Array, required: true }, selected: { type: String, default: "" },
	total: { type: Number, default: 0 }, loadMore: { type: Function, required: true },
	documentRoute: { type: Function, required: true }, displayValue: { type: Function, required: true },
	queryKey: { type: String, default: "" }, bulkActions: { type: Array, default: () => [] },
	relatedDoctypes: { type: Array, default: () => [] },
	dialogOpen: Boolean, loading: Boolean, savePosition: { type: Function, required: true },
	refresh: { type: Function, required: true }, filterFor: { type: Function, default: () => null },
})
const emit = defineEmits(["update:selected", "filter"])
const route = useRoute()
const router = useRouter()
const list = ref(null)
const previewPanel = ref(null)
const selectedName = ref("")
const isPhone = ref(Boolean(globalThis.window?.matchMedia?.("(max-width: 760px)").matches))
const selection = useSplitSelection(() => props.rows, () => props.queryKey)
const { names, selectedRows, allSelected } = selection
const isPreviewOpen = computed(() => Boolean(route.query.selected))
const selectedRow = computed(() => props.rows.find((row) => row.name === selectedName.value))
const mainFields = ["name", "supplier", "from_location", "to_location", "po_date", "posting_date", "total_qty", "total_output_qty", "grand_total", "total_amount", "total_declared_value", "total_dc_value"]
const secondaryColumns = computed(() => props.columns.filter((column) => !column.indicator && !mainFields.includes(column.fieldname)))
let media
let savedScroll = 0
let hasPushedPreview = false
let navigation = Promise.resolve()
let disposed = false

function syncSelection(name, updateRoute = true) {
	selectedName.value = name
	emit("update:selected", name)
	if (!updateRoute || (isPhone.value && !route.query.selected)) return
	const query = { ...route.query }
	if (name) query.selected = name
	else delete query.selected
	if (route.query.selected !== query.selected) router.replace({ query })
}

watch(() => props.rows, (rows, previous) => {
	const initial = !selectedName.value ? String(route.query.selected || props.selected || "") : selectedName.value
	syncSelection(reconcileSelection(rows, initial, previous))
}, { immediate: true, flush: "sync" })

watch(() => route.query.selected, async (name, previous) => {
	if (props.rows.some((row) => row.name === name)) syncSelection(name, false)
	if (!name && previous && isPhone.value) {
		hasPushedPreview = false
		await nextTick()
		window.scrollTo({ top: savedScroll, behavior: "instant" })
		list.value?.focus()
	}
})

async function choose(row) {
	selection.clear()
	if (!isPhone.value) { syncSelection(row.name); return }
	savedScroll = window.scrollY
	props.savePosition()
	syncSelection(row.name, false)
	hasPushedPreview = true
	await router.push({ query: { ...route.query, selected: row.name } })
	await nextTick()
	const topbarHeight = globalThis.document?.querySelector(".ops-topbar")?.getBoundingClientRect().height || 0
	window.scrollTo({ top: window.scrollY + previewPanel.value.getBoundingClientRect().top - topbarHeight, behavior: "instant" })
}

async function back() {
	selection.clear()
	if (route.query.selected && hasPushedPreview) { router.back(); return }
	const query = { ...route.query }
	delete query.selected
	await router.replace({ query })
	await nextTick()
	list.value?.focus()
}

async function move(direction) {
	const selected = selectedName.value
	const queryKey = props.queryKey
	const name = await navigateSelection({ rows: () => props.rows, selected, direction,
		hasMore: () => props.rows.length < props.total, loadMore: props.loadMore })
	if (disposed || queryKey !== props.queryKey || selectedName.value !== selected) return
	syncSelection(name)
	await nextTick()
	list.value?.querySelector?.('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" })
}

function keydown(event) {
	const hasDialog = props.dialogOpen || Boolean(globalThis.document?.querySelector?.('dialog[open], [role="dialog"], .p-dialog-mask, [role="menu"]'))
	if (hasDialog) return
	if (event.key === "Escape") { event.preventDefault(); escapeToList(); return }
	if (ignoresNavigation(event)) return
	if (event.key === "Enter") { openSelected(event); return }
	if (!["ArrowDown", "ArrowUp"].includes(event.key)) return
	event.preventDefault()
	navigation = navigation.then(() => move(event.key === "ArrowDown" ? 1 : -1))
}

function escapeToList() {
	selection.clear()
	if (isPhone.value && route.query.selected) back()
	else list.value?.focus()
}

function openSelected(event) {
	if (!selectedRow.value || event.target?.closest?.("button, a")) return
	event.preventDefault()
	props.savePosition()
	router.push(props.documentRoute(selectedName.value))
}

function resize() { isPhone.value = Boolean(media?.matches) }
function rowMetrics(row) {
	const quantity = row.amount != null ? null : `${Number(row.total_qty ?? row.total_output_qty ?? 0).toLocaleString("en-IN")} qty`
	const amount = [row.grand_total, row.total_amount, row.total_declared_value, row.total_dc_value, row.amount].find((value) => value != null)
	return [quantity, amount == null ? null : Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })].filter(Boolean).join(" · ")
}
const dateField = (row) => row.po_date ? "po_date" : row.posting_date ? "posting_date" : ""
const partyFields = (row) => props.doctype === "MGK Delivery Challan" ? ["from_location", "to_location"] : row.supplier ? ["supplier"] : []
function filterClick(event, row, fieldname) {
	const filter = props.filterFor(row, fieldname)
	if (!filter) return
	event.stopPropagation()
	emit("filter", filter)
}
onMounted(() => {
	media = window.matchMedia?.("(max-width: 760px)")
	resize()
	media?.addEventListener("change", resize)
})
onBeforeUnmount(() => { disposed = true; media?.removeEventListener("change", resize) })
</script>

<template>
	<div class="split-list" :class="{ 'preview-open': isPreviewOpen, 'bulk-open': names.length > 0 }" @keydown="keydown">
		<div class="split-records list-card" :aria-busy="loading">
			<div class="split-list-head"><label><input type="checkbox" :checked="allSelected" :indeterminate="names.length > 0 && !allSelected" @change="selection.toggleAll"> Select all loaded</label><span>{{ rows.length }}</span></div>
			<div v-if="loading" class="list-refreshing" role="status">Refreshing…</div>
			<div ref="list" role="listbox" aria-label="Documents" tabindex="0">
				<div v-if="!rows.length" class="empty-state compact"><h2>No records found</h2><p>Try a different search or clear your filters.</p></div>
				<div v-for="row in rows" :key="row.name" class="split-row" role="option" :aria-selected="row.name === selectedName" :tabindex="row.name === selectedName ? 0 : -1" @click="choose(row)">
					<input type="checkbox" :aria-label="`Select ${row.name}`" :checked="names.includes(row.name)" @click.stop @change="selection.toggle(row.name)">
					<div class="split-row-copy">
						<div class="split-row-head"><strong class="record-id">{{ row.name }}</strong><span class="status" :class="[statusPill(doctype, row).className, { 'list-filter-value': filterFor(row, '__status') }]" @click="filterClick($event, row, '__status')">{{ statusPill(doctype, row).label }}</span></div>
						<div class="split-party"><template v-if="partyFields(row).length"><template v-for="(fieldname, index) in partyFields(row)" :key="fieldname"><template v-if="index"> → </template><span :class="{ 'list-filter-value': filterFor(row, fieldname) }" @click="filterClick($event, row, fieldname)">{{ row[fieldname] || "—" }}</span></template></template><template v-else>{{ recordParty(doctype, row) }}</template></div>
						<div class="split-row-facts"><span v-if="dateField(row)" :class="{ 'list-filter-value': filterFor(row, dateField(row)) }" @click="filterClick($event, row, dateField(row))">{{ formatDate(row[dateField(row)]) }}</span><template v-if="dateField(row) && rowMetrics(row)"> · </template>{{ rowMetrics(row) }}</div>
						<div class="split-row-facts"><span v-for="column in secondaryColumns" :key="column.fieldname" :title="column.label" :class="{ 'list-filter-value': filterFor(row, column.fieldname) }" @click="filterClick($event, row, column.fieldname)">{{ displayValue(row, column) }}</span></div>
					</div>
				</div>
			</div>
		</div>
		<div ref="previewPanel" class="split-preview">
			<button class="button secondary preview-back" type="button" @click="back">‹ Back to list</button>
			<SelectionSummary v-if="names.length" :rows="selectedRows" :actions="bulkActions" :refresh="refresh" @clear="selection.clear" />
			<PreviewPane v-else :doctype="doctype" :row="selectedRow" :related-doctypes="relatedDoctypes" :document-route="documentRoute" :save-position="savePosition" :refresh="refresh" />
		</div>
	</div>
</template>
