<script setup>
import { ref, computed, nextTick, watch } from "vue"
import Button from "primevue/button"
import InputNumber from "primevue/inputnumber"
import LinkField from "../document/fields/LinkField.vue"
import { callRead } from "../api/client.js"
import { clone } from "../document/mappedDraft.js"
import { itemFilters as getItemFilters, validateItem } from "./editorModes.js"

const props = defineProps({ mode: String, defaults: Object, dimensions: Array, permissions: Object, poEntries: Array, itemGroup: String, editing: Object, disabled: Boolean })
const emit = defineEmits(["commit", "cancel"])
const itemInput = ref(null)
const entry = ref(null)
const details = ref(null)
const dimensions = ref({ ...props.defaults })
const item = ref("")
const loading = ref(false)
const error = ref("")
const resetVersion = ref(0)
let sequence = 0
const itemFilters = computed(() => getItemFilters(props.mode, { poEntries: props.poEntries, itemGroup: props.itemGroup }))
const keys = computed(() => details.value?.primary_attribute_values?.length ? details.value.primary_attribute_values : ["default"])

async function resolve(name) {
	const current = ++sequence
	loading.value = true
	error.value = ""
	entry.value = null
	try {
		const data = await callRead("yrp.yrp.doctype.yrp_item.yrp_item.get_attribute_details", { item_name: name })
		if (sequence !== current) return
		if (!data) throw new Error(`Could not resolve ${name}.`)
		details.value = data
		const values = Object.fromEntries((data.primary_attribute_values?.length ? data.primary_attribute_values : ["default"]).map((key) => [key, { qty: 0 }]))
		entry.value = { name, dimensions: clone(dimensions.value), attributes: {}, primary_attribute: data.primary_attribute || "", default_uom: data.default_uom, values }
	} catch (cause) { if (sequence === current) error.value = cause.message }
	finally { if (sequence === current) loading.value = false }
}

function reset() {
	sequence += 1
	item.value = ""
	entry.value = null
	details.value = null
	dimensions.value = clone(props.defaults)
	resetVersion.value += 1
	error.value = ""
	loading.value = false
}

async function commit() {
	try {
		if (!entry.value || entry.value.name !== item.value) throw new Error("Choose an item first.")
		for (const dim of props.dimensions) if (dim.mandatory && !dimensions.value[dim.fieldname]) throw new Error(`${dim.label} is required.`)
		for (const attr of details.value.attributes || []) if (attr !== details.value.primary_attribute && !entry.value.attributes[attr]) throw new Error(`Choose ${attr}.`)
		if (!Object.values(entry.value.values).some((cell) => Number(cell?.qty) > 0)) throw new Error("Enter Qty to continue")
		entry.value.dimensions = clone(dimensions.value)
		validateItem(entry.value, props.mode, props.poEntries)
		emit("commit", clone(details.value), clone(entry.value))
		reset()
		await nextTick()
		itemInput.value?.focus()
	} catch (cause) { error.value = cause.message }
}

watch(() => props.defaults, () => { if (!props.editing) dimensions.value = clone(props.defaults) }, { deep: true })
watch(() => props.editing, (editing) => {
	reset()
	if (!editing) return
	entry.value = clone(editing.entry)
	details.value = clone(editing.group)
	dimensions.value = clone(entry.value.dimensions || {})
	item.value = entry.value.name
}, { immediate: true })
function cancel() { reset(); emit("cancel") }
function updateCell(key, field, value) {
	entry.value.values[key] ||= { qty: 0 }
	entry.value.values[key][field] = value ?? 0
}
</script>

<template>
	<section class="stock-add-form">
		<h4>{{ editing ? 'Edit item' : 'Add item' }}</h4>
		<div v-if="error" class="editor-error" role="alert">{{ error }}</div>
		<div :key="resetVersion" class="form-grid">
			<div class="form-field">
				<label class="field-label">
					Item
					<span class="required">*</span>
				</label>
				<LinkField
					ref="itemInput"
					v-model="item"
					doctype="Item"
					label="Item"
					:disabled="disabled || Boolean(editing)"
					:filters="itemFilters"
					@select="resolve"
				/>
			</div>
			<div v-for="dimension in props.dimensions" :key="dimension.fieldname" class="form-field">
				<label class="field-label">
					{{ dimension.label }}
					<span v-if="dimension.mandatory" class="required">*</span>
				</label>
				<LinkField
					v-model="dimensions[dimension.fieldname]"
					:doctype="dimension.options"
					:label="dimension.label"
					:disabled="disabled || Boolean(editing) && permissions.lockDimensionsOnEdit"
				/>
			</div>
		</div>
		<p v-if="loading" role="status">Resolving item attributes…</p>
		<template v-if="entry">
			<div class="form-grid attribute-fields">
				<div v-for="attribute in (details.attributes || []).filter((value) => value !== details.primary_attribute)" :key="attribute" class="form-field">
					<label class="field-label">
						{{ attribute }}
						<span class="required">*</span>
					</label>
					<LinkField
						v-model="entry.attributes[attribute]"
						:label="attribute"
						search-method="yrp.yrp.doctype.yrp_item.yrp_item.search_item_attribute_values"
						:search-args="{ item, attribute }"
						:disabled="disabled"
					/>
				</div>
			</div>
			<div class="table-scroll">
				<table class="pivot-entry">
					<thead>
						<tr>
							<th>{{ details.primary_attribute || 'Quantity' }}</th>
							<th v-for="key in keys" :key="key">{{ key === 'default' ? 'Qty' : key }}</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<th>Qty ({{ entry.default_uom }})</th>
							<td v-for="key in keys" :key="key">
								<InputNumber
									:model-value="Number(entry.values[key]?.qty) || 0"
									:aria-label="`${key === 'default' ? 'Item' : key} quantity`"
									:min="0"
									:max="permissions.inlineQtyMaxField ? entry.values[key]?.[permissions.inlineQtyMaxField] : undefined"
									:max-fraction-digits="6"
							:disabled="disabled"
									fluid
									@update:model-value="updateCell(key, 'qty', $event)"
								/>
							</td>
						</tr>
						<tr v-if="mode !== 'plan'">
							<th>Rate</th>
							<td v-for="key in keys" :key="key">
								<InputNumber
									:model-value="Number(entry.values[key]?.rate) || 0"
									:aria-label="`${key === 'default' ? 'Item' : key} rate`"
							:disabled="disabled || !permissions.rateEditable"
									:min="0"
									:max-fraction-digits="6"
									fluid
									@update:model-value="updateCell(key, 'rate', $event)"
								/>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</template>
		<div class="editor-actions">
			<Button
				v-if="editing"
				label="Cancel edit"
				severity="secondary"
				outlined
				@click="cancel"
			/>
			<Button
				class="editor-commit"
				:label="editing ? 'Update item' : 'Add item'"
				:icon="editing ? 'pi pi-check' : 'pi pi-plus'"
				:disabled="disabled || loading || !entry"
				@click="commit"
			/>
		</div>
	</section>
</template>

<style scoped>
.stock-add-form { min-width: 0; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 20px; margin-bottom: 18px; }
@media (max-width: 700px) {
	.form-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
