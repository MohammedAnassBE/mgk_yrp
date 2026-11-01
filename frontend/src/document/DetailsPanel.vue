<script setup>
import { computed, ref, nextTick, onBeforeUnmount } from "vue"
import FieldControl from "./fields/FieldControl.vue"
import { fieldState, isEmpty, missingFields, visibleFields } from "./fieldConditions.js"
import { companionText, formatFieldValue } from "./fieldDisplay.js"
const props = defineProps({ fields: Array, doc: Object, meta: Object, metas: Array, candidates: Object, createDefaults: Object, autoFields: Array, hints: Object, disabled: Boolean, user: Object })
const emit = defineEmits(["change"])
const editing = ref(null)
let original
const overlays = ".p-select-overlay, .p-datepicker-panel, .p-overlay, .p-popover"
const root = ref(null)
const visible = computed(() => visibleFields(props.fields, props.doc, props.meta, props.user)
	.filter((field) => !(props.doc.doctype === "MGK Delivery Challan Close" && Number(props.doc.docstatus) === 0 && field.fieldname === "total_value_gap")))
const missing = computed(() => missingFields(props.fields, props.doc, props.meta, props.user))
function editable(field) { return !props.disabled && !fieldState(field, props.doc, props.meta, props.user).readOnly }
async function begin(field) {
	editing.value = field.fieldname
	original = props.doc[field.fieldname]
	globalThis.document?.addEventListener?.("pointerdown", pointerdown, true)
	await nextTick()
	root.value?.querySelector('input:not(:disabled), textarea:not(:disabled), [role="combobox"]:not(:disabled)')?.focus()
}
async function finish(refocus = false) {
	const fieldname = editing.value
	editing.value = null
	globalThis.document?.removeEventListener?.("pointerdown", pointerdown, true)
	if (!refocus) return
	await nextTick()
	root.value?.querySelector(`[data-field="${fieldname}"] .detail-row-button`)?.focus()
}
function isInsideEditor(target) {
	return Boolean(target?.closest?.(`[data-field="${editing.value}"], ${overlays}`))
}
function pointerdown(event) { if (!isInsideEditor(event.target)) finish() }
function focusout(event) { if (event.relatedTarget && !isInsideEditor(event.relatedTarget)) finish() }
function keydown(event) {
	if (event.key === "Escape") {
		if (props.doc[editing.value] !== original) emit("change", editing.value, original)
		finish(true)
	} else if (event.key === "Enter" && !event.target?.closest?.("textarea, .p-select, .p-datepicker")) {
		event.preventDefault()
		finish(true)
	}
}
onBeforeUnmount(() => globalThis.document?.removeEventListener?.("pointerdown", pointerdown, true))
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
			:data-field="field.fieldname"
			@focusout="editing === field.fieldname && focusout($event)"
			@keydown="editing === field.fieldname && keydown($event)"
		>
			<template v-if="editing === field.fieldname && editable(field)">
				<FieldControl
					:field="field"
					:doc="doc"
					:meta="meta"
					:metas="metas"
					:user="user"
					:candidates="candidates?.[field.fieldname] ?? null"
					:create-defaults="createDefaults?.[field.fieldname]"
					@change="(name, value) => emit('change', name, value)"
				/>
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
