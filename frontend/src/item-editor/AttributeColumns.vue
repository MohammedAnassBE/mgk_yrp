<script setup>
import { ref, watch } from "vue"
import Button from "primevue/button"
import InputNumber from "primevue/inputnumber"
import Select from "primevue/select"
import LinkField from "../document/fields/LinkField.vue"
import { formatFieldValue } from "../document/fieldDisplay.js"
import { displayName } from "../shell/displayLanguage.js"
import { columnOptions, loadDimensionOptions, nonPrimaryAttributes, refreshEntryUom, setCellValue, sizes } from "./attributeColumns.js"
import { attributeLinkProps } from "./attributeValues.js"

const props = defineProps({ items: Array, editable: Boolean, mode: String, dimensions: Array, hasTransferredQuantity: Boolean })
const emit = defineEmits(["changed", "split", "remove"])
const dimensionOptions = ref({})
const selected = ref([])
const loading = ref(false)
const error = ref("")
const rowKey = (groupIndex, entryIndex) => `${groupIndex}:${entryIndex}`
const money = (value) => formatFieldValue({ fieldtype: "Currency" }, value || 0)

async function loadOptions() {
	if (!props.editable) return
	loading.value = true
	error.value = ""
	try {
		await Promise.all(props.dimensions.filter((dimension) => !dimensionOptions.value[dimension.fieldname]).map(async (dimension) => {
			dimensionOptions.value[dimension.fieldname] = await loadDimensionOptions(dimension)
		}))
	} catch (cause) { error.value = cause.message }
	finally { loading.value = false }
}

watch(() => [props.editable, props.dimensions], loadOptions, { immediate: true, deep: true })
watch(() => props.items.map((group) => group.items.slice()), () => { selected.value = [] })

function setAttribute(group, entry, attribute, value) {
	entry.attributes ||= {}
	entry.attributes[attribute] = value || ""
	refreshEntryUom(group, entry)
	emit("changed")
}
function setDimension(entry, dimension, value) {
	entry.dimensions ||= {}
	entry.dimensions[dimension] = value || ""
	emit("changed")
}
function updateCell(entry, size, field, value) {
	const isNewCell = !entry.values[size]
	setCellValue(entry, size, field, value)
	if (isNewCell && entry.values[size]) entry.values[size].rate = getRowRate(entry)
	emit("changed")
}
function getRowRate(entry) {
	return Number(Object.values(entry.values).find((cell) => cell && Number(cell.rate))?.rate) || 0
}
function setRowRate(group, entry, value) {
	const cellSizes = sizes(group).filter((size) => entry.values[size])
	if (!cellSizes.length) cellSizes.push(sizes(group)[0])
	cellSizes.forEach((size) => setCellValue(entry, size, "rate", value))
	emit("changed")
}
function getRowAmount(group, entry) {
	return sizes(group).reduce((total, size) => total + Number(entry.values[size]?.qty || 0) * Number(entry.values[size]?.rate || 0), 0)
}
function selectRow(groupIndex, entryIndex, checked) {
	const key = rowKey(groupIndex, entryIndex)
	selected.value = selected.value.filter((value) => value !== key)
	if (checked) selected.value.push(key)
}
function isGroupSelected(groupIndex) {
	return props.items[groupIndex].items.every((entry, entryIndex) => selected.value.includes(rowKey(groupIndex, entryIndex)))
}
function selectGroup(groupIndex, checked) {
	props.items[groupIndex].items.forEach((entry, entryIndex) => selectRow(groupIndex, entryIndex, checked))
}
function removeSelected() {
	props.items.forEach((group, groupIndex) => {
		group.items = group.items.filter((entry, entryIndex) => !selected.value.includes(rowKey(groupIndex, entryIndex)))
	})
	selected.value = []
	emit("changed")
}
</script>

<template>
	<div class="attribute-columns">
		<p v-if="loading" class="loading-state" role="status">Loading column options…</p>
		<div v-if="error" class="form-banner" role="alert">
			{{ error }}
			<Button label="Retry column options" size="small" severity="secondary" @click="loadOptions" />
		</div>
		<div v-for="(group, groupIndex) in items" :key="groupIndex" class="table-scroll pivot-group">
			<table v-if="group.items.length">
				<thead><tr>
					<th v-if="editable"><input type="checkbox" aria-label="Select all rows"
						:checked="isGroupSelected(groupIndex)" @change="selectGroup(groupIndex, $event.target.checked)"></th>
					<th>Item</th>
					<th v-for="dimension in dimensions" :key="dimension.fieldname">{{ dimension.label }}</th>
					<th v-for="attribute in nonPrimaryAttributes(group)" :key="attribute">{{ attribute }}</th>
					<th v-for="size in sizes(group)" :key="size">{{ size === 'default' ? 'Quantity' : size }}</th>
					<th>UOM</th>
					<th v-if="mode !== 'plan'">Rate</th>
					<th v-if="hasTransferredQuantity">Transferred Qty</th>
					<th v-if="mode !== 'plan'">Amount</th>
					<th v-if="editable" class="actions-column">Actions</th>
				</tr></thead>
				<tbody><tr v-for="(entry, entryIndex) in group.items" :key="entryIndex">
					<td v-if="editable"><input type="checkbox" :aria-label="`Select row ${entryIndex + 1}`"
						:checked="selected.includes(rowKey(groupIndex, entryIndex))"
						@change="selectRow(groupIndex, entryIndex, $event.target.checked)"></td>
					<td><strong>{{ displayName("Item", entry.name) }}</strong></td>
					<td v-for="dimension in dimensions" :key="dimension.fieldname">
						<Select v-if="editable" :aria-label="dimension.label" :model-value="entry.dimensions?.[dimension.fieldname] || ''"
							:options="columnOptions(entry.dimensions?.[dimension.fieldname], dimensionOptions[dimension.fieldname])"
							@update:model-value="setDimension(entry, dimension.fieldname, $event)" />
						<span v-else>{{ displayName(dimension.options, entry.dimensions?.[dimension.fieldname]) || '—' }}</span>
					</td>
					<td v-for="attribute in nonPrimaryAttributes(group)" :key="attribute">
						<LinkField v-if="editable" :label="attribute" :model-value="entry.attributes?.[attribute] || ''"
							v-bind="attributeLinkProps(entry.name, attribute)" @update:model-value="setAttribute(group, entry, attribute, $event)" />
						<span v-else>{{ entry.attributes?.[attribute] || '—' }}</span>
					</td>
					<td v-for="size in sizes(group)" :key="size" class="pivot-cell">
						<InputNumber v-if="editable" :model-value="Number(entry.values[size]?.qty) || 0" :min="0" :max-fraction-digits="6" fluid
							:aria-label="`${entry.name} ${size} quantity`" @update:model-value="updateCell(entry, size, 'qty', $event)" />
						<strong v-else>{{ entry.values[size]?.qty || 0 }}</strong>
					</td>
					<td>{{ entry.default_uom || Object.values(entry.values).find(Boolean)?.uom || '—' }}
						<small v-if="entry.uom_hint" class="last-rate">{{ entry.uom_hint }}</small></td>
					<td v-if="mode !== 'plan'" class="rate-cell">
						<InputNumber v-if="editable" :model-value="getRowRate(entry)" :min="0" :max-fraction-digits="6" fluid
							:aria-label="`${entry.name} rate`" @update:model-value="setRowRate(group, entry, $event)" />
						<span v-else>{{ money(getRowRate(entry)) }}</span>
					</td>
					<td v-if="hasTransferredQuantity">
						<div v-for="size in sizes(group)" :key="size">{{ size === 'default' ? '' : `${size}: ` }}{{ entry.values[size]?.transferred_qty || 0 }} {{ entry.values[size]?.uom || entry.default_uom }}</div>
					</td>
					<td v-if="mode !== 'plan'" class="numeric">{{ money(getRowAmount(group, entry)) }}</td>
					<td v-if="editable" class="actions-column"><div class="row-actions">
						<Button icon="pi pi-plus" aria-label="Add split" title="Add split" size="small" severity="secondary" text
							@click="emit('split', groupIndex, entryIndex)" />
						<Button icon="pi pi-times" aria-label="Remove row" title="Remove row" size="small" severity="danger" text
							@click="emit('remove', groupIndex, entryIndex)" />
					</div></td>
				</tr></tbody>
			</table>
		</div>
		<Button v-if="editable && selected.length" :label="`Remove Selected (${selected.length})`" size="small" severity="danger" outlined @click="removeSelected" />
	</div>
</template>

<style scoped>
.attribute-columns { min-width: 0; max-width: 100%; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.pivot-cell { min-width: 6rem; }
:deep(.p-select) { min-width: 8rem; }
</style>
