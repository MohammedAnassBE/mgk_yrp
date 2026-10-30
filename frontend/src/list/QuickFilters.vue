<script setup>
import FilterValue from "./FilterValue.vue"

const props = defineProps({ modelValue: { type: Object, default: () => ({}) }, fields: { type: Array, default: () => [] } })
const emit = defineEmits(["update:modelValue"])
function update(field, value) { emit("update:modelValue", { ...props.modelValue, [field.fieldname]: value }) }
</script>

<template>
	<div v-if="fields.length" class="quick-filters">
		<div v-for="field in fields" :key="field.fieldname" class="quick-filter">
			<div v-if="field.fieldtype === 'Date'" class="quick-date">
				<input :id="`quick-${field.fieldname}`" type="date" :value="modelValue[field.fieldname] || ''" :aria-label="field.label" :placeholder="field.label" @input="update(field, $event.target.value)" />
				<span v-if="!modelValue[field.fieldname]" class="quick-date-placeholder" aria-hidden="true">{{ field.label }}</span>
			</div>
			<FilterValue v-else :input-id="`quick-${field.fieldname}`" :field="field" :label="field.label" :placeholder="field.label" :model-value="modelValue[field.fieldname] ?? ''" @update:model-value="update(field, $event)" />
		</div>
	</div>
</template>
