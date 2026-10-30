<script setup>
import { ref, computed } from "vue"
import Button from "primevue/button"
import InputNumber from "primevue/inputnumber"
import StockItemEntry from "./StockItemEntry.vue"
import { getItems as copyItems, addEntry, replaceEntry, loadItems } from "./editorPayload.js"
import { recalculate } from "./editorModes.js"
import { clone } from "../document/mappedDraft.js"
import { formatFieldValue } from "../document/fieldDisplay.js"

const props = defineProps({ mode: String, editable: Boolean, permissions: Object, defaults: Object, dimensions: Array, poEntries: Array })
const emit = defineEmits(["change"])
const groups = ref([])
const editPosition = ref(null)
const editing = computed(() => editPosition.value ? clone({ group: groups.value[editPosition.value.group], entry: groups.value[editPosition.value.group].items[editPosition.value.entry] }) : null)
function loadData(data) { groups.value = loadItems(data, props.mode); editPosition.value = null }
function getItems() { return copyItems(groups.value) }
function changed() { emit("change", recalculate(groups.value, props.mode)) }
function commit(details, entry) {
	if (editPosition.value) replaceEntry(groups.value, editPosition.value.group, editPosition.value.entry, entry)
	else addEntry(groups.value, details, entry)
	editPosition.value = null
	changed()
}
function remove(groupIndex, entryIndex) {
	groups.value[groupIndex].items.splice(entryIndex, 1)
	if (!groups.value[groupIndex].items.length) groups.value.splice(groupIndex, 1)
	editPosition.value = null
	changed()
}
function updateCell(cell, field, value) {
	cell[field] = value ?? 0
	changed()
}
function keys(group) { return group.primary_attribute_values?.length ? group.primary_attribute_values : ["default"] }
function visibleDimensions(group) {
	return props.dimensions.filter((dimension) => group.items.some((entry) => entry.dimensions?.[dimension.fieldname]))
}
function max(cell) {
	const value = cell[props.permissions.inlineQtyMaxField]
	return value == null ? undefined : Number(value)
}
const money = (value) => formatFieldValue({ fieldtype: "Currency" }, value || 0)
defineExpose({ loadData, getItems })
</script>

<template>
	<div class="stock-grid-editor">
		<p v-if="!groups.length" class="empty-state compact">No items yet. Add an item and enter the quantity.</p>
		<div v-for="(group, groupIndex) in groups" :key="groupIndex" class="table-scroll pivot-group">
			<table>
				<thead>
					<tr>
						<th>#</th>
						<th class="item-column">Item</th>
						<th v-for="dimension in visibleDimensions(group)" :key="dimension.fieldname">{{ dimension.label }}</th>
						<th v-for="attribute in group.attributes" :key="attribute">{{ attribute }}</th>
						<th v-for="key in keys(group)" :key="key">{{ key === 'default' ? 'Qty' : key }}</th>
						<th>UOM</th>
						<th v-if="permissions.canEdit || permissions.canRemove">Actions</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="(entry, entryIndex) in group.items" :key="`${entry.row_index || entryIndex}`">
						<td>{{ entryIndex + 1 }}</td>
						<td class="item-column">
							<strong>{{ entry.name }}</strong>
						</td>
						<td v-for="dimension in visibleDimensions(group)" :key="dimension.fieldname">{{ entry.dimensions?.[dimension.fieldname] || '—' }}</td>
						<td v-for="attribute in group.attributes" :key="attribute">{{ entry.attributes?.[attribute] || '—' }}</td>
						<td v-for="key in keys(group)" :key="key" class="pivot-cell">
							<template v-if="entry.values[key]">
								<InputNumber
									v-if="editable"
									:model-value="Number(entry.values[key].qty) || 0"
									:min="0"
									:max="max(entry.values[key])"
									:max-fraction-digits="6"
									fluid
									:aria-label="`${entry.name} ${key} quantity`"
									@update:model-value="updateCell(entry.values[key], 'qty', $event)"
								/>
								<strong v-else>{{ entry.values[key].qty || 0 }}</strong>
								<label class="cell-extra">
									Rate
									<InputNumber
										v-if="permissions.rateEditable"
										:model-value="Number(entry.values[key].rate) || 0"
										:min="0"
										:max-fraction-digits="6"
										fluid
										:aria-label="`${entry.name} ${key} rate`"
										@update:model-value="updateCell(entry.values[key], 'rate', $event)"
									/>
									<span v-else>{{ money(entry.values[key].rate) }}</span>
								</label>
									<small class="cell-extra">Amount: {{ money(Number(entry.values[key].qty || 0) * Number(entry.values[key].rate || 0)) }}</small>
								<template v-if="mode === 'grn_po'">
									<small class="cell-extra">Pending: {{ entry.values[key].pending_qty || 0 }}</small>
									<small class="cell-extra">Allowed: {{ entry.values[key].allowed_qty || 0 }}</small>
								</template>
							</template>
							<span v-else>—</span>
						</td>
						<td>{{ entry.default_uom || '—' }}</td>
						<td v-if="permissions.canEdit || permissions.canRemove">
							<div class="editor-actions">
								<Button
									v-if="permissions.canEdit"
									icon="pi pi-pencil"
									aria-label="Edit item"
									text
									severity="secondary"
									size="small"
									@click="editPosition = { group: groupIndex, entry: entryIndex }"
								/>
								<Button
									v-if="permissions.canRemove"
									icon="pi pi-trash"
									aria-label="Remove item"
									text
									severity="danger"
									size="small"
									@click="remove(groupIndex, entryIndex)"
								/>
							</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<StockItemEntry
			v-if="permissions.canCreate || editing"
			:mode="mode"
			:defaults="defaults"
			:dimensions="dimensions"
			:permissions="permissions"
			:po-entries="poEntries"
			:editing="editing"
			:disabled="!editable"
			@commit="commit"
			@cancel="editPosition = null"
		/>
	</div>
</template>
