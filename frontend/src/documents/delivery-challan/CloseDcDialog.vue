<script setup>
import { computed, onMounted, onScopeDispose, ref } from "vue"
import Button from "primevue/button"
import Message from "primevue/message"
import ActionDialog from "../shared/ActionDialog.vue"
import { callMethod } from "../../api/client.js"
import { closeDeliveryChallan, jobWorkMethods } from "../shared/jobWork.js"
import { intro, summary } from "../delivery-challan-close/presentation.js"
import { itemColumns as outputColumns } from "../delivery-challan-close/preview.js"
import { money } from "../previewValues.js"
import { formatDate } from "../../shared/formatDate.js"
import { isSaveShortcut } from "../../document/lifecycle.js"
import { notify } from "../../shared/notify.js"

const props = defineProps({ doc: { type: Object, required: true }, names: Array, rows: Array, action: Object })
const emit = defineEmits(["done", "close"])
const inputColumns = [{ key: "item", label: "Input Item" }, { key: "stock_uom", label: "UOM" },
	{ key: "remaining_stock_qty", label: "Qty to consume", numeric: true }, { key: "own_value", label: "Value", money: true }]
const close_preview = ref(null)
const is_loading = ref(false)
const is_saving = ref(false)
const error = ref("")
const notice = computed(() => close_preview.value && intro(close_preview.value, money))
const lines = computed(() => close_preview.value ? summary(close_preview.value).lines : [])
let is_disposed = false

async function load() {
	if (is_loading.value || close_preview.value) return
	is_loading.value = true
	error.value = ""
	try {
		const result = await callMethod(jobWorkMethods.previewClose, { source_name: props.doc.name })
		if (!is_disposed) close_preview.value = result
	} catch (cause) { if (!is_disposed) error.value = cause.message }
	finally { if (!is_disposed) is_loading.value = false }
}

async function save() {
	if (is_saving.value || !close_preview.value) return
	is_saving.value = true
	error.value = ""
	try { emit("done", await closeDeliveryChallan(props.doc.name, callMethod)) }
	catch (cause) { error.value = cause.message; notify.error(cause.message) }
	finally { is_saving.value = false }
}
function keydown(event) { if (isSaveShortcut(event)) { event.preventDefault(); save() } }
function cell(row, column) {
	const value = row[column.key]
	if (column.money) return money(value)
	return value == null || value === "" ? "—" : value
}
function close() { if (!is_saving.value) emit("close") }
onMounted(() => globalThis.window?.addEventListener?.("keydown", keydown))
onScopeDispose(() => { is_disposed = true; globalThis.window?.removeEventListener?.("keydown", keydown) })
</script>

<template>
	<ActionDialog visible :header="`Close ${doc.name}`" width="min(960px, 94vw)" @show="load" @close="close">
		<form id="close-dc-form" class="form-stack" @submit.prevent="save">
			<Message v-if="error" severity="error" :closable="false" class="form-banner">{{ error }}</Message>
			<div v-if="is_loading" class="loading-state" role="status">Loading close preview…</div>
			<button v-else-if="!close_preview && error" type="button" class="button secondary small" @click="load">Retry</button>
			<template v-if="close_preview">
				<Message :severity="notice.severity" :closable="false" class="form-banner">{{ notice.text }}</Message>
				<dl class="close-facts">
					<div><dt>Posting Date</dt><dd>{{ formatDate(close_preview.posting_date) }}</dd></div>
					<div><dt>Supplier</dt><dd>{{ close_preview.supplier || '—' }}</dd></div>
					<div><dt>Warehouse</dt><dd>{{ close_preview.warehouse || '—' }}</dd></div>
					<div v-for="line in lines" :key="line.label"><dt>{{ line.label }}</dt>
						<dd>{{ line.money ? money(line.value) : (line.value ?? '—') }}</dd></div>
				</dl>
				<div v-for="table in [{ title: 'Inputs consumed', columns: inputColumns, rows: close_preview.items || [] },
					{ title: 'Linked GRN outputs', columns: outputColumns, rows: close_preview.outputs || [] }]" :key="table.title">
					<h3 class="close-table-title">{{ table.title }}</h3>
					<p v-if="!table.rows.length" class="muted">None</p>
					<div v-else class="list-card table-scroll" tabindex="0" :aria-label="table.title">
						<table>
							<thead><tr><th v-for="column in table.columns" :key="column.key" :class="{ numeric: column.numeric || column.money }">{{ column.label }}</th></tr></thead>
							<tbody><tr v-for="(row, index) in table.rows" :key="row.name || index">
								<td v-for="column in table.columns" :key="column.key" :class="{ numeric: column.numeric || column.money }">{{ cell(row, column) }}</td>
							</tr></tbody>
						</table>
					</div>
				</div>
			</template>
		</form>
		<template #footer>
			<Button label="Cancel" severity="secondary" outlined :disabled="is_saving" @click="close" />
			<Button label="Close DC" type="submit" form="close-dc-form" :loading="is_saving" :disabled="is_saving || !close_preview" />
		</template>
	</ActionDialog>
</template>

<style scoped>
.close-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px 16px; margin: 0; }
.close-facts dt { color: var(--color-muted); font-size: 12px; }
.close-facts dd { margin: 0; font-weight: 500; }
.close-table-title { font-size: 13px; font-weight: 600; margin: 4px 0 6px; }
table { width: 100%; }
.numeric { text-align: right; }
</style>
