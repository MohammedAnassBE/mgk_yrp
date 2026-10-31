<script setup>
import { computed, onBeforeUnmount, ref, toRaw } from "vue"
import FieldControl from "./FieldControl.vue"
import { metaDefaults } from "../newDocDefaults.js"
import { fieldState } from "../fieldConditions.js"
import { formatFieldValue } from "../fieldDisplay.js"
import { tableFields } from "./tableFields.js"
import { childChange } from "../../masters/masterFields.js"
import { conversionDefaults, conversionOutputUom, isProcessConversion } from "../../masters/itemConversions.js"

const props = defineProps({ modelValue: Array, field: Object, metas: Array, parentDoc: Object, parentMeta: Object, user: Object, disabled: Boolean })
const emit = defineEmits(["update:modelValue"])
const meta = computed(() => props.metas.find((meta) => meta.name === props.field.options))
const permissionMeta = computed(() => ({ ...meta.value, permissions: props.parentMeta.permissions }))
const fields = computed(() => tableFields(meta.value, props.field, props.parentDoc, permissionMeta.value, props.modelValue[0], props.user))
const isConversion = computed(() => isProcessConversion(props.parentDoc, props.field))
const error = ref("")
const rowKeys = new WeakMap()
const requests = new Map()
onBeforeUnmount(() => requests.clear())
function rowKey(row) { const raw = toRaw(row); return raw.name || rowKeys.get(raw) || raw }
function replaceRow(index, patch) {
	const rows = [...props.modelValue]
	const previous = rows[index]
	rows[index] = { ...previous, ...patch }
	rowKeys.set(rows[index], rowKey(previous))
	emit("update:modelValue", rows)
}
async function updateOutput(key, item) {
	const request = Symbol()
	requests.set(key, request)
	error.value = ""
	try {
		const to_uom = await conversionOutputUom(item)
		if (requests.get(key) !== request) return
		const index = props.modelValue.findIndex((row) => rowKey(row) === key && row.item === item)
		if (index >= 0) replaceRow(index, { to_uom })
	} catch (cause) { if (requests.get(key) === request) error.value = cause.message }
	finally { if (requests.get(key) === request) requests.delete(key) }
}
function readOnly(field, row) {
	return props.disabled || fieldState(field, { ...row, docstatus: props.parentDoc?.docstatus ?? row.docstatus }, permissionMeta.value, props.user, props.parentDoc).readOnly
}
function change(index, name, value) {
	if (props.disabled) return
	const row = props.modelValue[index]
	const patch = childChange(row, name, value, meta.value.fields)
	const isItemChange = isConversion.value && name === "item"
	if (isItemChange) Object.assign(patch, conversionDefaults(props.parentDoc), { to_uom: null })
	replaceRow(index, patch)
	if (isItemChange) updateOutput(rowKey(row), value)
}
function add() {
	if (props.disabled) return
	const row = { ...metaDefaults(meta.value, new Date(), globalThis.window?.frappe?.boot, props.parentDoc), parentfield: props.field.fieldname, idx: props.modelValue.length + 1 }
	if (isConversion.value) Object.assign(row, conversionDefaults(props.parentDoc))
	emit("update:modelValue", [...props.modelValue, row])
}
function remove(index) {
	if (props.disabled) return
	requests.delete(rowKey(props.modelValue[index]))
	emit("update:modelValue", props.modelValue.filter((row, position) => position !== index))
}
</script>

<template>
	<div v-if="meta" class="simple-table">
		<p v-if="error" class="form-banner" role="alert">{{ error }}</p>
		<p v-if="!modelValue.length" class="empty-state compact">No rows yet.</p>
		<div v-else class="table-scroll" :class="{ natural: field.columns }">
			<table>
				<thead>
					<tr>
						<th>#</th>
						<th v-for="field in fields" :key="field.fieldname">{{ field.label }}</th>
						<th v-if="!disabled" class="row-actions" />
					</tr>
				</thead>
				<tbody>
					<tr v-for="(row, index) in modelValue" :key="row.name || index">
						<td>{{ index + 1 }}</td>
						<td v-for="field in fields" :key="field.fieldname">
							<span v-if="readOnly(field, row)" class="read-only-cell">{{ formatFieldValue(field, row[field.fieldname]) }}</span>
							<FieldControl
								v-else
								:field="field"
								:doc="{ ...row, parent: parentDoc?.name, parenttype: parentDoc?.doctype }"
								:parent-doc="parentDoc"
								:meta="permissionMeta"
								:metas="metas"
								:user="user"
								:disabled="disabled"
								@change="(name, value) => change(index, name, value)"
							/>
						</td>
						<td v-if="!disabled">
							<button type="button" class="button secondary small" @click="remove(index)">Remove</button>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<button
			v-if="!disabled"
			type="button"
			class="button secondary small"
			@click="add"
		>Add row</button>
	</div>
	<p v-else class="error-state">Child table metadata is unavailable.</p>
</template>
