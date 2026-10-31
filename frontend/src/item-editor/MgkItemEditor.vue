<script setup>
import { computed, ref, watch, onScopeDispose } from "vue"
import StockItemGridEditor from "./StockItemGridEditor.vue"
import { callRead, callMethod } from "../api/client.js"
import { editorMode, editorPermissions } from "./editorModes.js"
import { attachTransferredQuantities, loadItems } from "./editorPayload.js"
import "../document/document.css"

const props = defineProps({ doc: { type: Object, default: () => ({}) }, editable: Boolean,
	mode: { type: String, default: "" }, itemDetails: { type: [Array, String], default: null } })
const emit = defineEmits(["change", "ready", "loaded"])
const grid = ref(null)
const context = ref({ defaults: {}, po_entries: [] })
const dimensions = ref([])
const loading = ref(true)
const error = ref("")
const mode = computed(() => props.mode || editorMode(props.doc))
const hasTransferredQuantity = computed(() => Boolean(props.doc.is_internal_transfer) && !props.editable)
const permissions = computed(() => editorPermissions(mode.value, props.editable && !loading.value && !error.value))
let sequence = 0
let loadedItems = []

async function initialize() {
	const current = ++sequence
	loading.value = true
	error.value = ""
	emit("ready", false)
	try {
		const [result, dims] = await Promise.all([
			callRead("mgk_yrp.stock.item_editor.get_editor_context", { purchase_order: mode.value === "grn_po" ? props.doc.purchase_order : null }),
			callRead("yrp.stock.api.get_stock_dimensions_for_ui"),
		])
		let data = props.itemDetails ?? props.doc.__onload?.item_details ?? props.doc.item_details
		if (!data && props.doc.items?.length && Number(props.doc.docstatus) === 0 && mode.value !== "plan") data = await callMethod("mgk_yrp.stock.item_editor.get_draft_item_details", { doc: JSON.stringify(props.doc) })
		if (sequence !== current) return
		context.value = result
		dimensions.value = dims
		loadedItems = loadItems(data, mode.value)
		if (hasTransferredQuantity.value) attachTransferredQuantities(loadedItems, props.doc.items)
		emit("loaded", loadedItems.reduce((sum, group) => sum + group.items.length, 0))
		loading.value = false
		emit("ready", true)
	} catch (cause) { if (sequence === current) error.value = cause.message }
	finally { if (sequence === current) loading.value = false }
}
watch(grid, (value) => { if (value) value.loadData(loadedItems) })
watch(() => [props.doc, mode.value, props.itemDetails, props.doc.purchase_order, props.doc.__onload?.item_details, props.doc.item_details, hasTransferredQuantity.value], initialize, { immediate: true })
onScopeDispose(() => { sequence += 1 })
defineExpose({ getItems: () => grid.value?.getItems() || [], isReady: () => !loading.value && !error.value })
</script>

<template>
	<div v-if="loading" class="loading-state" role="status">
		<i class="pi pi-spin pi-spinner" />
		Loading items…
	</div>
	<div v-else-if="error" class="error-state" role="alert">
		{{ error }}
		<button type="button" class="button secondary small" @click="initialize">Retry</button>
	</div>
	<StockItemGridEditor
		v-else
		ref="grid"
		:mode="mode"
		:editable="editable"
		:permissions="permissions"
		:defaults="context.defaults"
		:dimensions="dimensions"
		:po-entries="context.po_entries"
		:has-transferred-quantity="hasTransferredQuantity"
		:supplier="doc.supplier || ''"
		:current-document="doc.__islocal ? '' : doc.name || ''"
		@change="$emit('change', $event)"
	/>
</template>
