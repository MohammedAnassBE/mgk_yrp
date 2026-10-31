<script setup>
import { computed } from "vue"
import DatePicker from "primevue/datepicker"
import { toIsoDate } from "./formatDate.js"

const props = defineProps({ modelValue: { type: String, default: "" }, inputId: String, ariaLabel: String, placeholder: String, required: Boolean })
const emit = defineEmits(["update:modelValue"])
const dateValue = computed(() => props.modelValue ? new Date(`${props.modelValue}T00:00:00`) : null)
</script>

<template>
	<DatePicker :model-value="dateValue" :input-id="inputId" :aria-label="ariaLabel" :placeholder="placeholder" :required="required"
		date-format="dd-mm-yy" show-button-bar fluid @update:model-value="emit('update:modelValue', toIsoDate($event))" />
</template>
