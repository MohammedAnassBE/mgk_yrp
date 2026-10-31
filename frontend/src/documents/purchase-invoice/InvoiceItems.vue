<script setup>
import { formatDate } from "../../shared/formatDate.js"
import { computed, ref, watch } from "vue"
import Button from "primevue/button"
import Dialog from "primevue/dialog"
import { callMethod, callDocMethod, callRead } from "../../api/client.js"
import { createGrnFlow } from "./grnFlow.js"
import { canGetGrns, groupGrnRows } from "./fieldEvents.js"
import InvoiceRows from "./InvoiceRows.vue"
import { money } from "../previewValues.js"

const props = defineProps({ doc: Object, disabled: Boolean, metas: Array, meta: Object })
const emit = defineEmits(["change", "update", "loading", "messages"])
const visible = ref(false)
const receipts = ref([])
const selected = ref([])
const busy = ref(false)
const error = ref("")
const groups = computed(() => groupGrnRows(props.doc.items || []))
const dates = ref({})
watch(receipts, (list) => { dates.value = { ...dates.value, ...Object.fromEntries(list.map((receipt) => [receipt.name, receipt.posting_date])) } })
watch(() => groups.value.map((group) => group.name).filter((name) => name && !(name in dates.value)), async (missing) => {
	if (!missing.length) return
	const found = await callRead("frappe.client.get_list", { doctype: "MGK Goods Received Note", filters: [["name", "in", missing]],
		fields: ["name", "posting_date"], limit_page_length: 0 }).catch((cause) => { error.value = cause.message; return [] })
	dates.value = { ...dates.value, ...Object.fromEntries(found.map((receipt) => [receipt.name, receipt.posting_date])) }
}, { immediate: true })
const flow = createGrnFlow({ getDoc: () => props.doc, call: callMethod, callDoc: callDocMethod,
	update: (patch) => emit("update", patch), messages: (messages) => emit("messages", messages) })
async function perform(action) {
	if (busy.value || props.disabled) return
	busy.value = true
	error.value = ""
	emit("loading", true)
	try { await action() }
	catch (cause) { error.value = cause.message }
	finally { busy.value = false; emit("loading", false) }
}
function open() {
	return perform(async () => {
		selected.value = []
		receipts.value = await flow.list()
		visible.value = receipts.value.length > 0
	})
}
function fetchRows() { return perform(async () => { if (await flow.fetch(selected.value)) visible.value = false }) }
watch(() => [props.doc, props.doc.supplier, props.doc.against], () => { visible.value = false; error.value = "" })
</script>

<template>
	<section class="child-editor" :class="{ 'po-saved-items': Number(doc.docstatus) !== 0 }">
		<header class="child-editor-head">
			<span class="book-step">2</span>
			<div><h2>Billed GRN rows</h2><small>Review the received goods included in this bill.</small></div>
			<Button v-if="canGetGrns(doc) && !disabled" label="Get GRNs" size="small" severity="secondary" outlined :loading="busy" @click="open" />
			<span v-else class="count-chip">{{ doc.items?.length || 0 }} rows</span>
		</header>
		<div class="table-field-body">
			<p v-if="busy" role="status">Loading GRN details…</p>
			<p v-if="error" role="alert" class="editor-error">{{ error }} <Button label="Retry Get GRNs" severity="secondary" size="small" @click="open" /></p>
			<InvoiceRows :groups="groups" :dates="dates" :doc="doc" :meta="meta" :metas="metas" :disabled="disabled || busy" @change="(name, rows) => emit('change', name, rows)" />
		</div>
		<Dialog v-model:visible="visible" modal header="Get GRNs" :style="{ width: 'min(640px, 94vw)' }" :closable="!busy">
			<p>Unbilled GRNs</p>
			<table class="grn-choices">
				<thead><tr><th></th><th>GRN ID</th><th>Date</th><th class="numeric">Total Qty</th><th class="numeric">Total Amount</th></tr></thead>
				<tbody>
					<tr v-for="receipt in receipts" :key="receipt.name">
						<td><input :id="`grn-${receipt.name}`" v-model="selected" type="checkbox" :value="receipt.name" :disabled="busy"></td>
						<td><label :for="`grn-${receipt.name}`">{{ receipt.name }}</label></td>
						<td>{{ formatDate(receipt.posting_date) }}</td>
						<td class="numeric">{{ receipt.total_qty }}</td>
						<td class="numeric">{{ money(receipt.total_amount) }}</td>
					</tr>
				</tbody>
			</table>
			<p v-if="busy" role="status">Fetching GRN rows and taxes…</p>
			<p v-if="error" class="editor-error" role="alert">{{ error }}</p>
			<template #footer><Button label="Fetch" :disabled="busy || !selected.length" :loading="busy" @click="fetchRows" /></template>
		</Dialog>
	</section>
</template>
