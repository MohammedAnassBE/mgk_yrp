<script setup>
import LinkInput from "./LinkInput.vue"
import DateInput from "../shared/DateInput.vue"
import { selectChoices, inputType, timespans } from "./filterFields.js"

defineProps({ modelValue: { default: "" }, field: { type: Object, default: () => ({}) }, operator: { type: String, default: "=" }, label: { type: String, default: "Value" }, placeholder: String, inputId: String })
defineEmits(["update:modelValue"])
</script>

<template>
	<select v-if="operator === 'is'" :id="inputId" :value="modelValue" :aria-label="label" @change="$emit('update:modelValue', $event.target.value)">
		<option value="">Choose…</option><option value="set">Set</option><option value="not set">Not Set</option>
	</select>
	<select v-else-if="operator === 'timespan'" :id="inputId" :value="modelValue" :aria-label="label" @change="$emit('update:modelValue', $event.target.value)">
		<option value="">Choose…</option><option v-for="value in timespans" :key="value" :value="value">{{ value }}</option>
	</select>
	<input v-else-if="['in', 'not in', 'like', 'not like'].includes(operator)" :id="inputId" :value="modelValue" :aria-label="label" :placeholder="['in', 'not in'].includes(operator) ? 'Comma separated values' : 'Value (use % as wildcard)'" @input="$emit('update:modelValue', $event.target.value)" />
	<LinkInput v-else-if="field.fieldtype === 'Link'" :model-value="modelValue" :doctype="field.options" :label="label" :placeholder="placeholder" :input-id="inputId" @update:model-value="$emit('update:modelValue', $event)" />
	<select v-else-if="['Select', 'Check'].includes(field.fieldtype)" :id="inputId" :value="modelValue" :aria-label="label" @change="$emit('update:modelValue', $event.target.value)">
		<option value="">{{ placeholder || 'All / choose…' }}</option><option v-for="[value, text] in selectChoices(field)" :key="value" :value="value">{{ text }}</option>
	</select>
	<DateInput v-else-if="field.fieldtype === 'Date'" :input-id="inputId" :model-value="modelValue || ''" :aria-label="label" :placeholder="placeholder" @update:model-value="$emit('update:modelValue', $event)" />
	<input v-else :id="inputId" :type="inputType(field)" :value="modelValue" :aria-label="label" :placeholder="placeholder" step="any" @input="$emit('update:modelValue', $event.target.value)" />
</template>
