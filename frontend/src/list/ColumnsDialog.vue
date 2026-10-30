<script setup>
import { computed, ref, watch } from "vue"
import Dialog from "primevue/dialog"
import { saveUserColumns, resetUserColumns } from "./listColumns.js"

const props = defineProps({ visible: Boolean, doctype: { type: String, required: true }, columns: { type: Array, default: () => [] }, statusLabel: { type: String, default: "Status" } })
const emit = defineEmits(["update:visible", "saved"])
const draft = ref([])
const search = ref("")
const saving = ref(false)
const error = ref("")
const dragField = ref("")
const matching = computed(() => draft.value.filter((column) => `${column.label} ${column.fieldname}`.toLowerCase().includes(search.value.toLowerCase())))
const enabled = computed(() => draft.value.filter((column) => column.enabled))
watch(() => props.visible, (visible) => {
	if (!visible) return
	draft.value = structuredClone(props.columns.map((column) => ({ ...column })))
	search.value = ""
	error.value = ""
})
function move(field, before) {
	if (!field || field === before) return
	const from = draft.value.findIndex((column) => column.fieldname === field)
	if (from < 0) return
	const [column] = draft.value.splice(from, 1)
	const to = draft.value.findIndex((candidate) => candidate.fieldname === before)
	draft.value.splice(to < 0 ? draft.value.length : to, 0, column)
	dragField.value = ""
}
function step(index, direction) {
	const field = enabled.value[index].fieldname
	const before = enabled.value[index + (direction < 0 ? -1 : 2)]?.fieldname
	move(field, before)
}
async function persist(reset = false) {
	saving.value = true
	error.value = ""
	try {
		if (reset) await resetUserColumns(props.doctype)
		else await saveUserColumns(props.doctype, draft.value)
		emit("saved")
		emit("update:visible", false)
	} catch (cause) { error.value = cause.message }
	finally { saving.value = false }
}
</script>

<template>
	<Dialog :visible="visible" modal header="Columns" class="list-dialog columns-dialog" :closable="!saving" @update:visible="$emit('update:visible', $event)">
		<p>Choose and order columns for this book. ID stays first; {{ statusLabel }} stays last.</p>
		<div v-if="error" class="dialog-error" role="alert">{{ error }}</div>
		<div class="columns-editor">
			<div><label class="column-search">Find a column<input v-model="search" type="search" aria-label="Find a column" /></label>
				<div class="column-picker"><label v-for="column in matching" :key="column.fieldname"><input v-model="column.enabled" type="checkbox" :disabled="saving" />{{ column.label }}</label><p v-if="!matching.length">No matching fields.</p></div>
			</div>
			<div class="column-order" @dragover.prevent @drop.prevent="move(dragField)">
				<strong>ID (fixed)</strong>
				<div v-for="(column, index) in enabled" :key="column.fieldname" class="column-order-row" :draggable="!saving" @dragstart="dragField = column.fieldname; $event.dataTransfer.setData('text/plain', column.fieldname)" @dragend="dragField = ''" @dragover.prevent.stop @drop.prevent.stop="move(dragField, column.fieldname)">
					<span aria-hidden="true">⠿</span><span>{{ column.label }}</span>
					<button type="button" class="button secondary small" :aria-label="`Move ${column.label} up`" :disabled="saving || index === 0" @click="step(index, -1)">↑</button>
					<button type="button" class="button secondary small" :aria-label="`Move ${column.label} down`" :disabled="saving || index === enabled.length - 1" @click="step(index, 1)">↓</button>
				</div>
				<strong>{{ statusLabel }} (fixed)</strong>
			</div>
		</div>
		<template #footer><button class="button secondary" type="button" :disabled="saving" @click="persist(true)">Reset</button><button class="button primary" type="button" :disabled="saving" @click="persist(false)">{{ saving ? "Saving…" : "Save columns" }}</button></template>
	</Dialog>
</template>
