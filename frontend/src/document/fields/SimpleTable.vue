<script setup>
import { computed } from "vue"
import FieldControl from "./FieldControl.vue"
import { clone } from "../mappedDraft.js"
import { metaDefaults } from "../newDocDefaults.js"
import { fieldState } from "../fieldConditions.js"
import { formatFieldValue } from "../fieldDisplay.js"
import { tableFields } from "./tableFields.js"
import { childChange } from "../../masters/masterFields.js"

const props = defineProps({ modelValue: Array, field: Object, metas: Array, parentDoc: Object, parentMeta: Object, user: Object, disabled: Boolean })
const emit = defineEmits(["update:modelValue"])
const meta = computed(() => props.metas.find((meta) => meta.name === props.field.options))
const permissionMeta = computed(() => ({ ...meta.value, permissions: props.parentMeta.permissions }))
const fields = computed(() => tableFields(meta.value, props.field, props.parentDoc, permissionMeta.value, props.modelValue[0], props.user))
function readOnly(field, row) {
	return props.disabled || fieldState(field, { ...row, docstatus: props.parentDoc?.docstatus ?? row.docstatus }, permissionMeta.value, props.user, props.parentDoc).readOnly
}
function change(index, name, value) {
	const rows = clone(props.modelValue)
	Object.assign(rows[index], childChange(rows[index], name, value, meta.value.fields))
	emit("update:modelValue", rows)
}
function add() {
	const row = { ...metaDefaults(meta.value, new Date(), globalThis.window?.frappe?.boot, props.parentDoc), parentfield: props.field.fieldname, idx: props.modelValue.length + 1 }
	emit("update:modelValue", [...props.modelValue, row])
}
function remove(index) { emit("update:modelValue", props.modelValue.filter((row, position) => position !== index)) }
</script>

<template>
	<div v-if="meta" class="simple-table">
		<p v-if="!modelValue.length" class="empty-state compact">No rows yet.</p>
		<div v-else class="table-scroll">
			<table>
				<thead>
					<tr>
						<th>#</th>
						<th v-for="field in fields" :key="field.fieldname">{{ field.label }}</th>
						<th v-if="!disabled" />
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
								:doc="row"
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
