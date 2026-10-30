<script setup>
import { computed } from "vue"
import InputNumber from "primevue/inputnumber"
import { hasPermission } from "../../permissions/usePermissions.js"
import { fieldState } from "../../document/fieldConditions.js"
import { formatFieldValue } from "../../document/fieldDisplay.js"
import { clone } from "../../document/mappedDraft.js"

const props = defineProps({ groups: Array, doc: Object, meta: Object, metas: Array, disabled: Boolean })
const emit = defineEmits(["change"])
const child = computed(() => props.metas.find((meta) => meta.name === "MGK Purchase Invoice Item"))
const permissionMeta = computed(() => ({ permissions: props.meta.permissions }))
const fields = computed(() => {
	const names = ["item", "qty", "uom", "grn_rate", "rate", "amount", "gst_rate",
		...(props.doc.tax_type === "IGST" ? ["igst_amount"] : props.doc.tax_type === "CGST + SGST" ? ["cgst_amount", "sgst_amount"] : [])]
	return names.map((name) => child.value?.fields.find((field) => field.fieldname === name)).filter((field) => field && fieldState(field, props.doc, permissionMeta.value).visible)
		.map((field) => ({ ...field, label: ({ gst_rate: "GST %", cgst_amount: "CGST", sgst_amount: "SGST", igst_amount: "IGST" })[field.fieldname] || field.label }))
})
function numeric(field) { return ["Currency", "Float", "Int", "Percent"].includes(field.fieldtype) }
function editable(field) { return field.fieldname === "rate" && !props.disabled && !fieldState(field, props.doc, permissionMeta.value).readOnly }
function change(index, rate) {
	const rows = clone(props.doc.items)
	rows[index].rate = rate ?? 0
	emit("change", "items", rows)
}
</script>

<template>
	<div class="simple-table invoice-rows">
		<p v-if="!child" class="error-state" role="alert">Billing row metadata is unavailable.</p>
		<p v-else-if="!groups.length" class="empty-state compact">No GRN rows yet. Choose a supplier and type, then Get GRNs.</p>
		<section v-for="group in child ? groups : []" :key="group.name" class="invoice-grn-group">
			<h3><RouterLink v-if="hasPermission('MGK Goods Received Note')" :to="`/goods-received-note/${encodeURIComponent(group.name)}`">{{ group.name }} ›</RouterLink><span v-else>{{ group.name }}</span></h3>
			<div class="table-scroll"><table>
				<thead><tr><th v-for="field in fields" :key="field.fieldname" :class="{ 'item-column': field.fieldname === 'item', numeric: numeric(field), 'rate-column': field.fieldname === 'rate' }">{{ field.label }}</th></tr></thead>
				<tbody><tr v-for="entry in group.rows" :key="entry.row.name || entry.row.goods_received_note_item">
					<td v-for="field in fields" :key="field.fieldname" :class="{ 'item-column': field.fieldname === 'item', numeric: numeric(field), 'rate-column': field.fieldname === 'rate' }">
						<InputNumber v-if="editable(field)" :model-value="Number(entry.row.rate) || 0" :min="0" :min-fraction-digits="2" :max-fraction-digits="2" :aria-label="`${entry.row.item} rate`" fluid @update:model-value="change(entry.index, $event)" />
						<span v-else class="read-only-cell">{{ formatFieldValue(field, entry.row[field.fieldname]) }}</span>
					</td>
				</tr></tbody>
			</table></div>
		</section>
	</div>
</template>
