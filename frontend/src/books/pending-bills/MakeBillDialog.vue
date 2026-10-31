<script setup>
import { computed, ref, watch } from "vue"
import Button from "primevue/button"
import Dialog from "primevue/dialog"
import InputNumber from "primevue/inputnumber"
import InputText from "primevue/inputtext"
import DateInput from "../../shared/DateInput.vue"
import { callMethod } from "../../api/client.js"
import { toIsoDate } from "../../shared/formatDate.js"
import { money } from "../../documents/previewValues.js"
import { notify } from "../../shared/notify.js"
import { billPayload, blockTotals, buildBlocks, draftGroups, failedSupplier, method, removeGrn, setDraftRate, typeLabel, validateBlocks } from "./pendingBills.js"

const props = defineProps({ visible: Boolean, groups: { type: Array, default: () => [] } })
const emit = defineEmits(["update:visible", "created", "remove"])
const blocks = ref([])
const loading = ref(false)
const saving = ref(false)
const error = ref("")
const notes = ref([])
const busy = computed(() => loading.value || saving.value)
let sequence = 0

async function loadDrafts() {
	const current = ++sequence
	blocks.value = []
	error.value = ""
	notes.value = []
	loading.value = true
	try {
		const names = props.groups.flatMap((group) => group.grns)
		const drafts = await callMethod(`${method}.get_bill_drafts`, { grn_names: names }, (messages) => { notes.value = messages })
		if (current === sequence) blocks.value = buildBlocks(props.groups, drafts || [], toIsoDate(new Date()))
	} catch (cause) { if (current === sequence) error.value = cause.message }
	finally { if (current === sequence) loading.value = false }
}
watch(() => props.visible, (visible) => { if (visible) loadDrafts(); else sequence++ }, { immediate: true })

function changeRate(block, draftIndex, group, rate) {
	block.drafts[draftIndex] = setDraftRate(block.drafts[draftIndex], group.indices, rate)
}
const taxColumns = (draft) => draft.tax_type === "IGST" ? [["igst_amount", "IGST"]]
	: draft.tax_type === "CGST + SGST" ? [["cgst_amount", "CGST"], ["sgst_amount", "SGST"]] : []

function remove(name) {
	blocks.value = removeGrn(blocks.value, name)
	emit("remove", name)
	if (!blocks.value.length) emit("update:visible", false)
}

async function submit() {
	if (busy.value || !blocks.value.length) return
	error.value = ""
	blocks.value = validateBlocks(blocks.value)
	if (blocks.value.some((block) => block.error)) return
	saving.value = true
	try {
		const created = await callMethod(`${method}.create_bills`, { bills: billPayload(blocks.value) })
		emit("created", created || [])
		emit("update:visible", false)
	} catch (cause) {
		const supplier = failedSupplier(cause)
		const block = blocks.value.find((entry) => entry.supplier === supplier)
		if (block) block.error = cause.message
		else error.value = cause.message
		notify.error(cause.message)
	} finally { saving.value = false }
}
</script>

<template>
	<Dialog :visible="visible" modal header="Make Bill" class="make-bill-dialog" :style="{ width: 'min(960px, 96vw)' }" :closable="!saving"
		@update:visible="emit('update:visible', $event)">
		<p v-if="loading" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> Loading GRN rows and taxes…</p>
		<p v-if="error" class="editor-error" role="alert">{{ error }}</p>
		<p v-for="note in notes" :key="note" class="make-bill-note">{{ note }}</p>
		<section v-for="block in blocks" :key="block.supplier" class="make-bill-block" :class="{ 'has-error': block.error }">
			<header><h3>{{ block.supplier_name }}</h3><span>{{ block.grns.length }} GRNs</span></header>
			<ul class="make-bill-grns" aria-label="GRNs in this bill">
				<li v-for="grn in block.grns" :key="grn">{{ grn }}<button type="button" :disabled="saving" :aria-label="`Remove ${grn}`" title="Remove from this bill" @click="remove(grn)"><i class="pi pi-times" aria-hidden="true" /></button></li>
			</ul>
			<div class="make-bill-fields">
				<label><span>Supplier Invoice No *</span><InputText v-model="block.bill_no" :id="`bill-no-${block.supplier}`" :disabled="saving" :aria-label="`${block.supplier_name} Supplier Invoice No`" /></label>
				<label><span>Supplier Invoice Date *</span><DateInput v-model="block.bill_date" :input-id="`bill-date-${block.supplier}`" :aria-label="`${block.supplier_name} Supplier Invoice Date`" required /></label>
			</div>
			<p v-if="block.error" class="editor-error" role="alert">{{ block.error }}</p>
			<div v-for="(draft, draftIndex) in block.drafts" :key="draft.against" class="make-bill-draft">
				<small class="make-bill-type">{{ block.drafts.length > 1 ? `${typeLabel(draft.against)} bill · ` : '' }}{{ draft.tax_type }}</small>
				<div class="table-scroll"><table class="make-bill-items">
					<thead><tr><th>Item</th><th>UOM</th><th class="numeric">Qty</th><th class="numeric">GRN Rate</th><th class="numeric">Rate</th><th class="numeric">Amount</th><th class="numeric">GST %</th><th v-for="[field, label] in taxColumns(draft)" :key="field" class="numeric">{{ label }}</th></tr></thead>
					<tbody><tr v-for="group in draftGroups(draft)" :key="group.key">
						<td>{{ group.item_name || group.item }}</td><td>{{ group.uom }}</td>
						<td class="numeric">{{ group.qty }}</td><td class="numeric">{{ money(group.grn_rate) }}</td>
						<td class="numeric rate-cell"><InputNumber :model-value="Number(group.rate) || 0" :min="0" :min-fraction-digits="2" :max-fraction-digits="2" :disabled="saving"
							:aria-label="`${group.item_name || group.item} rate`" fluid @update:model-value="changeRate(block, draftIndex, group, $event)" /></td>
						<td class="numeric">{{ money(group.amount) }}</td><td class="numeric">{{ group.gst_rate || 0 }}</td>
						<td v-for="[field] in taxColumns(draft)" :key="field" class="numeric">{{ money(group[field]) }}</td>
					</tr></tbody>
				</table></div>
			</div>
			<footer class="make-bill-totals">
				<span>Net <strong>{{ money(blockTotals(block).net_total) }}</strong></span>
				<span>Tax <strong>{{ money(blockTotals(block).total_tax) }}</strong></span>
				<span>Grand Total <strong>{{ money(blockTotals(block).grand_total) }}</strong></span>
			</footer>
		</section>
		<template #footer>
			<Button label="Cancel" severity="secondary" outlined :disabled="saving" @click="emit('update:visible', false)" />
			<Button label="Create & Submit Bills" :disabled="busy || !blocks.length" :loading="saving" @click="submit" />
		</template>
	</Dialog>
</template>
