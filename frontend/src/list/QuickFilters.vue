<script setup>
import { t } from "../shell/terminology.js"
import FilterValue from "./FilterValue.vue"
import DateInput from "../shared/DateInput.vue"

const props = defineProps({ modelValue: { type: Object, default: () => ({}) }, fields: { type: Array, default: () => [] } })
const emit = defineEmits(["update:modelValue"])
function update(field, value) { emit("update:modelValue", { ...props.modelValue, [field.fieldname]: value }) }
</script>

<template>
	<div v-if="fields.length" class="quick-filters">
		<div v-for="field in fields" :key="field.fieldname" class="quick-filter">
			<DateInput v-if="field.fieldtype === 'Date'" :input-id="`quick-${field.fieldname}`" :model-value="modelValue[field.fieldname] || ''" :aria-label="t(field.label)" :placeholder="t(field.label)" @update:model-value="update(field, $event)" />
			<FilterValue v-else :input-id="`quick-${field.fieldname}`" :field="field" :label="t(field.label)" :placeholder="t(field.label)" :model-value="modelValue[field.fieldname] ?? ''" @update:model-value="update(field, $event)" />
		</div>
	</div>
</template>
