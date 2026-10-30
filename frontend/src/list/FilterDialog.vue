<script setup>
import { ref, watch } from "vue"
import Dialog from "primevue/dialog"
import FilterValue from "./FilterValue.vue"
import { fieldConditions, filterTuples } from "./filterFields.js"

const props = defineProps({ visible: Boolean, fields: { type: Array, default: () => [] }, filters: { type: Array, default: () => [] } })
const emit = defineEmits(["update:visible", "apply"])
const rows = ref([])
const error = ref("")
let nextId = 0
watch(() => props.visible, (visible) => {
	if (!visible) return
	error.value = ""
	rows.value = props.filters.map(([field, operator, value]) => ({ id: nextId++, field, operator: operator.toLowerCase(), value: Array.isArray(value) ? (operator.toLowerCase() === "between" ? value[0] : value.join(", ")) : value, end: Array.isArray(value) ? value[1] : "" }))
})
function fieldFor(row) { return props.fields.find((field) => field.fieldname === row.field) || {} }
function add() { rows.value.push({ id: nextId++, field: "name", operator: "=", value: "", end: "" }) }
function changeField(row) {
	row.operator = fieldConditions(fieldFor(row))[0][0]
	row.value = ""
	row.end = ""
}
function apply() {
	try {
		emit("apply", filterTuples(rows.value, props.fields))
		emit("update:visible", false)
	} catch (cause) { error.value = cause.message }
}
function clear() { rows.value = []; apply() }
</script>

<template>
	<Dialog :visible="visible" modal header="Filters" class="list-dialog filter-dialog" @update:visible="$emit('update:visible', $event)">
		<p>Show records matching every condition.</p>
		<div v-if="error" class="dialog-error" role="alert">{{ error }}</div>
		<div v-if="!rows.length" class="empty-state compact"><h2>No filters</h2><p>Add a condition to narrow this list.</p></div>
		<div v-for="(row, index) in rows" :key="row.id" class="filter-row">
			<select v-model="row.field" :aria-label="`Filter ${index + 1} field`" @change="changeField(row)"><option v-for="field in fields" :key="field.fieldname" :value="field.fieldname">{{ field.label }}</option></select>
			<select v-model="row.operator" :aria-label="`Filter ${index + 1} condition`" @change="row.value = ''; row.end = ''"><option v-for="[value, label] in fieldConditions(fieldFor(row))" :key="value" :value="value">{{ label }}</option></select>
			<div class="filter-values"><FilterValue v-model="row.value" :field="fieldFor(row)" :operator="row.operator" :label="`Filter ${index + 1} value`" /><FilterValue v-if="row.operator === 'between'" v-model="row.end" :field="fieldFor(row)" :label="`Filter ${index + 1} end`" /></div>
			<button class="button secondary small" type="button" :aria-label="`Remove filter ${index + 1}`" @click="rows.splice(index, 1)">×</button>
		</div>
		<button class="button secondary small" type="button" @click="add">+ Add condition</button>
		<template #footer><button class="button secondary" type="button" @click="clear">Clear Filters</button><button class="button primary" type="button" @click="apply">Apply filters</button></template>
	</Dialog>
</template>
