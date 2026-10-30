<script setup>
import { computed, ref, nextTick } from "vue"
import FieldControl from "./fields/FieldControl.vue"
import { fieldState, isEmpty, missingFields, visibleFields } from "./fieldConditions.js"
import { companionText, formatFieldValue } from "./fieldDisplay.js"
const props = defineProps({ fields: Array, doc: Object, meta: Object, metas: Array, candidates: Object, autoFields: Array, hints: Object, disabled: Boolean, user: Object })
defineEmits(["change"])
const editing = ref(null)
const root = ref(null)
const visible = computed(() => visibleFields(props.fields, props.doc, props.meta, props.user)
	.filter((field) => !(props.doc.doctype === "MGK Delivery Challan Close" && Number(props.doc.docstatus) === 0 && field.fieldname === "total_value_gap")))
const missing = computed(() => missingFields(props.fields, props.doc, props.meta, props.user))
function editable(field) { return !props.disabled && !fieldState(field, props.doc, props.meta, props.user).readOnly }
async function begin(field) {
	editing.value = field.fieldname
	await nextTick()
	root.value?.querySelector('input:not(:disabled), textarea:not(:disabled), [role="combobox"]:not(:disabled)')?.focus()
}
function display(field) {
	const value = props.doc[field.fieldname]
	if (field.fieldtype === "Check") return Number(value) ? "Yes" : "No"
	if (Array.isArray(value)) return value.length ? `${value.length} selected` : "—"
	return formatFieldValue(field, value)
}
</script>
<template>
	<section ref="root" class="order-summary-card details-panel">
		<header class="details-panel-head">
			<h2>Details</h2>
			<span v-if="missing.length" class="missing-badge">{{ missing.length }} missing</span>
		</header>
		<div
			v-for="field in visible"
			:key="field.fieldname"
			class="detail-row"
			:class="{ 'is-missing': missing.includes(field) }"
		>
			<template v-if="editing === field.fieldname && editable(field)">
				<FieldControl
					:field="field"
					:doc="doc"
					:meta="meta"
					:metas="metas"
					:user="user"
					:candidates="candidates?.[field.fieldname] ?? null"
					@change="(name, value) => $emit('change', name, value)"
				/>
				<button type="button" class="button secondary small" @click="editing = null">Done</button>
			</template>
			<button
				v-else
				type="button"
				class="detail-row-button"
				:disabled="!editable(field)"
				@click="begin(field)"
			>
				<span class="detail-row-label">
					{{ field.label }}
					<small v-if="autoFields?.includes(field.fieldname)" class="auto-tag">auto</small>
				</span>
				<strong v-if="missing.includes(field) && isEmpty(doc[field.fieldname], field)">Missing — choose {{ field.label }}</strong>
				<strong v-else>{{ display(field) }}</strong>
			</button>
			<small v-if="companionText(field, doc)" class="detail-companion">{{ companionText(field, doc) }}</small>
			<small v-if="hints?.[field.fieldname]" class="field-help">{{ hints[field.fieldname] }}</small>
		</div>
	</section>
</template>
