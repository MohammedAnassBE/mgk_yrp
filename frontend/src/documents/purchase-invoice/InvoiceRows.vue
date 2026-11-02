<script setup>
import { formatDate } from "../../shared/formatDate.js"
import { computed, ref, watch } from "vue"
import InputNumber from "primevue/inputnumber"
import { hasPermission } from "../../permissions/usePermissions.js"
import { fieldState } from "../../document/fieldConditions.js"
import { formatFieldValue } from "../../document/fieldDisplay.js"
import { clone } from "../../document/mappedDraft.js"
import { itemAttributeNames, money } from "../previewValues.js"
import { loadItemAttributes, withItemAttributes } from "../itemAttributes.js"
import { attributeValueName } from "../../shell/displayLanguage.js"
import { groupItemRows, grnSummaries, setGroupRate } from "./fieldEvents.js"
import { t } from "../../shell/terminology.js"

const props = defineProps({ groups: Array, doc: Object, meta: Object, metas: Array, disabled: Boolean, dates: { type: Object, default: () => ({}) } })
const emit = defineEmits(["change"])
const child = computed(() => props.metas.find((meta) => meta.name === "MGK Purchase Invoice Item"))
const permissionMeta = computed(() => ({ permissions: props.meta.permissions }))
const receipts = computed(() => grnSummaries(props.groups, props.dates))
const itemGroups = computed(() => withItemAttributes(groupItemRows(props.doc.items || [])))
const attributes = computed(() => itemAttributeNames(itemGroups.value))
const attributeError = ref("")
watch(() => (props.doc.items || []).map((row) => row.item), (names) => {
	attributeError.value = ""
	loadItemAttributes(names).catch((cause) => { attributeError.value = cause.message })
}, { immediate: true })
const canRemove = computed(() => !props.disabled && Number(props.doc.docstatus || 0) === 0)
const fields = computed(() => {
	const names = ["item", "qty", "uom", "grn_rate", "rate", "amount", "gst_rate",
		...(props.doc.tax_type === "IGST" ? ["igst_amount"] : props.doc.tax_type === "CGST + SGST" ? ["cgst_amount", "sgst_amount"] : [])]
	return names.map((name) => child.value?.fields.find((field) => field.fieldname === name)).filter((field) => field && fieldState(field, props.doc, permissionMeta.value).visible)
		.map((field) => ({ ...field, label: ({ qty: "Total Qty", gst_rate: "GST %", cgst_amount: "CGST", sgst_amount: "SGST", igst_amount: "IGST" })[field.fieldname] || field.label }))
})
function numeric(field) { return ["Currency", "Float", "Int", "Percent"].includes(field.fieldtype) }
function editable(field) { return field.fieldname === "rate" && !props.disabled && !fieldState(field, props.doc, permissionMeta.value).readOnly }
function change(group, rate) { emit("change", "items", setGroupRate(clone(props.doc.items), group.indices, rate)) }
function remove(name) { emit("change", "items", clone(props.doc.items).filter((row) => row.goods_received_note !== name)) }
</script>

<template>
	<div class="simple-table invoice-rows">
		<p v-if="!child" class="error-state" role="alert">{{ t('Billing row metadata is unavailable.') }}</p>
		<p v-else-if="!groups.length" class="empty-state compact">{{ t('No GRN rows yet. Choose a supplier and type, then Get GRNs.') }}</p>
		<template v-else>
			<table class="grn-choices invoice-grns">
				<thead><tr><th>{{ t('GRN ID') }}</th><th>{{ t('Date') }}</th><th class="numeric">{{ t('Total Qty') }}</th><th class="numeric">{{ t('Total Amount') }}</th><th v-if="canRemove"></th></tr></thead>
				<tbody><tr v-for="receipt in receipts" :key="receipt.name">
					<td><RouterLink v-if="hasPermission('MGK Goods Received Note')" :to="`/goods-received-note/${encodeURIComponent(receipt.name)}`">{{ receipt.name }}</RouterLink><span v-else>{{ receipt.name }}</span></td>
					<td>{{ formatDate(receipt.posting_date) }}</td>
					<td class="numeric">{{ receipt.total_qty }}</td>
					<td class="numeric">{{ money(receipt.total_amount) }}</td>
					<td v-if="canRemove" class="numeric"><button type="button" class="grn-remove" :aria-label="`Remove ${receipt.name}`" @click="remove(receipt.name)">×</button></td>
				</tr></tbody>
			</table>
			<p v-if="attributeError" class="editor-error" role="alert">{{ attributeError }}</p>
			<div class="table-scroll"><table class="invoice-item-table">
				<thead><tr><template v-for="field in fields" :key="field.fieldname"><th :class="{ 'item-column': field.fieldname === 'item', numeric: numeric(field), 'rate-column': field.fieldname === 'rate' }">{{ t(field.label) }}</th>
					<template v-if="field.fieldname === 'item'"><th v-for="attribute in attributes" :key="attribute">{{ t(attribute) }}</th></template></template></tr></thead>
				<tbody><tr v-for="group in itemGroups" :key="group.key">
					<template v-for="field in fields" :key="field.fieldname"><td :class="{ 'item-column': field.fieldname === 'item', numeric: numeric(field), 'rate-column': field.fieldname === 'rate' }">
						<InputNumber v-if="editable(field)" :model-value="Number(group.rate) || 0" :min="0" :min-fraction-digits="2" :max-fraction-digits="2" :aria-label="`${group.item} rate`" fluid @update:model-value="change(group, $event)" />
						<span v-else class="read-only-cell">{{ formatFieldValue(field, field.fieldname === 'item' ? group.item_template || group.item : group[field.fieldname]) }}</span>
					</td>
					<template v-if="field.fieldname === 'item'"><td v-for="attribute in attributes" :key="attribute">{{ attributeValueName(attribute, group.item_attributes?.[attribute]) || '—' }}</td></template></template>
				</tr></tbody>
			</table></div>
		</template>
	</div>
</template>
