<script setup>
import { ref, computed } from "vue"
import Button from "primevue/button"
import InputNumber from "primevue/inputnumber"
import Select from "primevue/select"
import ActionDialog from "../documents/shared/ActionDialog.vue"
import AttributeColumns from "./AttributeColumns.vue"
import StockItemEntry from "./StockItemEntry.vue"
import { getItems as copyItems, addEntry, addSplit, replaceEntry, loadItems } from "./editorPayload.js"
import { recalculate, usesAttributeColumns } from "./editorModes.js"
import { splitLines } from "./attributeColumns.js"
import { clone } from "../document/mappedDraft.js"
import { formatFieldValue } from "../document/fieldDisplay.js"
import { displayName } from "../shell/displayLanguage.js"
import { useLastRates } from "./useLastRates.js"

const props = defineProps({ mode: String, editable: Boolean, permissions: Object, defaults: Object, dimensions: Array, poEntries: Array, hasTransferredQuantity: Boolean,
	supplier: String, currentDocument: String, itemGroup: String })
const emit = defineEmits(["change"])
const groups = ref([])
const editPosition = ref(null)
const isSplitDialogVisible = ref(false)
const splitLine = ref("")
const splitMessage = ref("")
const attributeGrid = computed(() => usesAttributeColumns(props.mode))
const lines = computed(() => splitLines(groups.value))
const editing = computed(() => editPosition.value ? clone({ group: groups.value[editPosition.value.group], entry: groups.value[editPosition.value.group].items[editPosition.value.entry] }) : null)
function loadData(data) { groups.value = loadItems(data, props.mode); editPosition.value = null; isSplitDialogVisible.value = false }
function getItems() { return copyItems(groups.value) }
function changed() { splitMessage.value = ""; emit("change", recalculate(groups.value, props.mode)) }
function commit(details, entry) {
	if (editPosition.value) replaceEntry(groups.value, editPosition.value.group, editPosition.value.entry, entry)
	else addEntry(groups.value, details, entry)
	editPosition.value = null
	changed()
}
function remove(groupIndex, entryIndex) {
	groups.value[groupIndex].items.splice(entryIndex, 1)
	if (!attributeGrid.value && !groups.value[groupIndex].items.length) groups.value.splice(groupIndex, 1)
	editPosition.value = null
	changed()
}
function removeAll() {
	groups.value = []
	editPosition.value = null
	changed()
}
function split(groupIndex, entryIndex) {
	addSplit(groups.value, groupIndex, entryIndex)
	editPosition.value = null
	changed()
}
function showSplitDialog() {
	splitMessage.value = lines.value.length ? "" : "Add an item before splitting."
	if (!lines.value.length) return
	splitLine.value = ""
	isSplitDialogVisible.value = true
}
function confirmSplit() {
	const line = lines.value.find((line) => line.label === splitLine.value)
	if (!line) return
	split(line.groupIndex, line.entryIndex)
	isSplitDialogVisible.value = false
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
const isFlat = (group) => !group.primary_attribute_values?.length
const lastRates = useLastRates({ groups, supplier: () => props.supplier, currentDocument: () => props.currentDocument,
	enabled: () => props.mode === "po" && props.editable })
const money = (value) => formatFieldValue({ fieldtype: "Currency" }, value || 0)
defineExpose({ loadData, getItems })
</script>

<template>
	<div class="stock-grid-editor">
		<div v-if="attributeGrid && editable" class="editor-actions">
			<Button label="Add Split" size="small" severity="secondary" outlined @click="showSplitDialog" />
			<Button label="Remove All" size="small" severity="secondary" outlined @click="removeAll" />
		</div>
		<p v-if="splitMessage" class="form-banner" role="status">{{ splitMessage }}</p>
		<p v-if="!groups.some((group) => group.items.length)" class="empty-state compact">No items yet. Add an item and enter the quantity.</p>
		<AttributeColumns v-if="attributeGrid" :items="groups" :editable="editable" :mode="mode" :dimensions="dimensions"
			:has-transferred-quantity="hasTransferredQuantity" @changed="changed" @split="split" @remove="remove" />
		<template v-else>
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
						<th v-if="isFlat(group)">Rate</th>
						<th v-if="isFlat(group)">Amount</th>
						<th v-if="hasTransferredQuantity">Transferred Qty</th>
						<th v-if="permissions.canEdit || permissions.canRemove">Actions</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="(entry, entryIndex) in group.items" :key="`${entry.row_index || entryIndex}`">
						<td>{{ entryIndex + 1 }}</td>
						<td class="item-column">
							<strong>{{ displayName("Item", entry.name) }}</strong>
						</td>
						<td v-for="dimension in visibleDimensions(group)" :key="dimension.fieldname">{{ displayName(dimension.options, entry.dimensions?.[dimension.fieldname]) || '—' }}</td>
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
								<template v-if="!isFlat(group)">
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
								<small v-if="lastRates.hint(groupIndex, entryIndex, key)" class="cell-extra last-rate">{{ lastRates.hint(groupIndex, entryIndex, key) }}</small>
								<small class="cell-extra">Amount: {{ money(Number(entry.values[key].qty || 0) * Number(entry.values[key].rate || 0)) }}</small>
								</template>
								<template v-if="mode === 'grn_po'">
									<small class="cell-extra">Pending: {{ entry.values[key].pending_qty || 0 }}</small>
									<small class="cell-extra">Allowed: {{ entry.values[key].allowed_qty || 0 }}</small>
								</template>
							</template>
							<span v-else>—</span>
						</td>
						<td>{{ entry.default_uom || '—' }}</td>
						<td v-if="isFlat(group)" class="rate-cell">
							<template v-if="entry.values.default">
								<InputNumber
									v-if="permissions.rateEditable"
									:model-value="Number(entry.values.default.rate) || 0"
									:min="0"
									:max-fraction-digits="6"
									fluid
									:aria-label="`${entry.name} default rate`"
									@update:model-value="updateCell(entry.values.default, 'rate', $event)"
								/>
								<span v-else>{{ money(entry.values.default.rate) }}</span>
								<small v-if="lastRates.hint(groupIndex, entryIndex, 'default')" class="last-rate">{{ lastRates.hint(groupIndex, entryIndex, 'default') }}</small>
							</template>
							<span v-else>—</span>
						</td>
						<td v-if="isFlat(group)" class="numeric">{{ entry.values.default ? money(Number(entry.values.default.qty || 0) * Number(entry.values.default.rate || 0)) : '—' }}</td>
						<td v-if="hasTransferredQuantity">
							<div v-for="key in keys(group)" :key="key">{{ key === 'default' ? '' : `${key}: ` }}{{ entry.values[key]?.transferred_qty || 0 }} {{ entry.values[key]?.uom || entry.default_uom }}</div>
						</td>
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
		</template>
		<StockItemEntry
			v-if="permissions.canCreate || editing"
			:mode="mode"
			:defaults="defaults"
			:dimensions="dimensions"
			:permissions="permissions"
			:po-entries="poEntries"
			:item-group="itemGroup"
			:editing="editing"
			:disabled="!editable"
			@commit="commit"
			@cancel="editPosition = null"
		/>
		<ActionDialog :visible="isSplitDialogVisible" header="Add Split" @close="isSplitDialogVisible = false">
			<div class="form-field">
				<label class="field-label" for="split-line">Line</label>
				<Select v-model="splitLine" input-id="split-line" aria-label="Line" :options="lines.map((line) => line.label)" fluid />
			</div>
			<template #footer>
				<Button label="Cancel" size="small" severity="secondary" outlined @click="isSplitDialogVisible = false" />
				<Button label="Add Split" size="small" :disabled="!splitLine" @click="confirmSplit" />
			</template>
		</ActionDialog>
	</div>
</template>

<style scoped>
.stock-grid-editor { min-width: 0; max-width: 100%; }
.table-scroll { max-width: 100%; overflow-x: auto; }
</style>
