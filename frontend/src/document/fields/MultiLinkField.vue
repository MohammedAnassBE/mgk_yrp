<script setup>
import { computed, ref } from "vue"
import LinkField from "./LinkField.vue"
import { fieldQuery } from "../fieldQueries.js"
const props = defineProps({ field: Object, modelValue: Array, metas: Array, doc: Object, disabled: Boolean })
const emit = defineEmits(["update:modelValue"])
const selected = ref("")
const child = computed(() => props.metas.find((meta) => meta.name === props.field.options))
const link = computed(() => child.value?.fields.find((field) => field.fieldtype === "Link"))
function add(value) {
	if (props.modelValue.some((row) => row[link.value.fieldname] === value)) return
	emit("update:modelValue", [...props.modelValue, { doctype: props.field.options, [link.value.fieldname]: value, __islocal: 1 }])
	selected.value = ""
}
</script>
<template>
	<div v-if="link" class="multi-link-field">
		<div v-for="(row, index) in modelValue" :key="row.name || index" class="multi-link-value">
			{{ row[link.fieldname] }}
			<button
				v-if="!disabled"
				type="button"
				class="button secondary small"
				:aria-label="`Remove ${row[link.fieldname]}`"
				@click="$emit('update:modelValue', modelValue.filter((_, position) => index !== position))"
			>
				×
			</button>
		</div>
		<LinkField
			v-if="!disabled"
			v-model="selected"
			:doctype="link.options"
			:label="field.label"
			v-bind="fieldQuery(field, doc)"
			@select="add"
		/>
	</div>
	<p v-else class="error-state">Link table metadata is unavailable.</p>
</template>
