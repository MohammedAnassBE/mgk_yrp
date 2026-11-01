<script setup>
import { computed, getCurrentInstance } from "vue"
import InputText from "primevue/inputtext"
import InputNumber from "primevue/inputnumber"
import Select from "primevue/select"
import Textarea from "primevue/textarea"
import ToggleSwitch from "primevue/toggleswitch"
import DatePicker from "primevue/datepicker"
import LinkField from "./LinkField.vue"
import SimpleTable from "./SimpleTable.vue"
import MultiLinkField from "./MultiLinkField.vue"
import { fieldState } from "../fieldConditions.js"
import { fieldQuery } from "../fieldQueries.js"
import { dynamicTarget } from "../../masters/masterFields.js"

const props = defineProps({ field: Object, doc: Object, parentDoc: Object, meta: Object, metas: Array, candidates: { type: Array, default: null }, createDefaults: Object, disabled: Boolean, user: Object })
const emit = defineEmits(["change"])
const instanceId = getCurrentInstance().uid
const state = computed(() => fieldState(props.field, props.doc, props.meta, props.user, props.parentDoc || props.doc))
const readOnly = computed(() => props.disabled || state.value.readOnly)
const value = computed(() => props.doc[props.field.fieldname])
const target = computed(() => dynamicTarget(props.field, props.doc))
const query = computed(() => fieldQuery(props.field, props.doc))
const id = computed(() => `field-${instanceId}-${props.field.fieldname}`)
const longText = ["Small Text", "Text", "Long Text", "Text Editor"]
const dateValue = computed(() => {
	if (!value.value) return null
	if (props.field.fieldtype === "Datetime") return new Date(String(value.value).replace(" ", "T"))
	return new Date(props.field.fieldtype === "Time" ? `2000-01-01T${value.value}` : `${value.value}T00:00:00`)
})
function change(value) { emit("change", props.field.fieldname, value) }
function dateChanged(value) {
	if (!value) return change(null)
	if (props.field.fieldtype === "Time") return change(value.toTimeString().slice(0, 8))
	const date = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
	change(props.field.fieldtype === "Datetime" ? `${date} ${value.toTimeString().slice(0, 8)}` : date)
}
</script>

<template>
	<div
		v-if="state.visible"
		class="form-field"
		:class="{ wide: [...longText, 'Table', 'Table MultiSelect'].includes(field.fieldtype) }"
	>
		<label class="field-label" :for="id">
			{{ field.label || field.fieldname }}
			<span v-if="state.required" class="required">*</span>
		</label>
		<LinkField
			v-if="['Link', 'Dynamic Link'].includes(field.fieldtype)"
			:input-id="id"
			:model-value="value"
			:doctype="target"
			:label="field.label"
			:disabled="readOnly"
			:candidates="candidates"
			:create-defaults="createDefaults"
			v-bind="query"
			@update:model-value="change"
		/>
		<Textarea
			v-else-if="longText.includes(field.fieldtype)"
			:id="id"
			:model-value="value"
			:disabled="readOnly"
			:placeholder="field.placeholder"
			auto-resize
			rows="3"
			fluid
			@update:model-value="change"
		/>
		<div v-else-if="field.fieldtype === 'Check'" class="check-field">
			<ToggleSwitch
				:input-id="id"
				:model-value="Boolean(Number(value))"
				:disabled="readOnly"
				@update:model-value="change($event ? 1 : 0)"
			/>
			<span>{{ Number(value) ? field.boolLabels?.on || field.label : field.boolLabels?.off || `Not ${field.label?.toLowerCase()}` }}</span>
		</div>
		<Select
			v-else-if="field.fieldtype === 'Select'"
			:input-id="id"
			:model-value="value"
			:options="(field.options || '').split('\n')"
			:disabled="readOnly"
			fluid
			@update:model-value="change"
		/>
		<DatePicker
			v-else-if="['Date', 'Time', 'Datetime'].includes(field.fieldtype)"
			:input-id="id"
			:model-value="dateValue"
			:aria-label="field.label || field.fieldname"
			:disabled="readOnly"
			:time-only="field.fieldtype === 'Time'"
			:show-time="field.fieldtype === 'Datetime'"
			:show-seconds="field.fieldtype === 'Time'"
			date-format="dd-mm-yy"
			hour-format="24"
			:manual-input="false"
			fluid
			@update:model-value="dateChanged"
		/>
		<InputNumber
			v-else-if="['Int', 'Float', 'Currency', 'Percent'].includes(field.fieldtype)"
			:input-id="id"
			:model-value="Number(value) || 0"
			:disabled="readOnly"
			:min-fraction-digits="field.fieldtype === 'Currency' && readOnly ? 2 : 0"
			:max-fraction-digits="field.fieldtype === 'Int' ? 0 : field.fieldtype === 'Currency' && readOnly ? 2 : Number(field.precision || 6)"
			fluid
			@update:model-value="change"
		/>
		<MultiLinkField
			v-else-if="field.fieldtype === 'Table MultiSelect'"
			:field="field"
			:model-value="value || []"
			:metas="metas"
			:doc="doc"
			:disabled="readOnly"
			@update:model-value="change"
		/>
		<SimpleTable
			v-else-if="field.fieldtype === 'Table'"
			:field="field"
			:model-value="value || []"
			:metas="metas"
			:parent-meta="meta"
			:parent-doc="doc"
			:user="user"
			:disabled="readOnly"
			@update:model-value="change"
		/>
		<InputText
			v-else
			:id="id"
			:model-value="value == null ? '' : String(value)"
			:disabled="readOnly"
			fluid
			@update:model-value="change"
		/>
		<small v-if="field.description" class="field-help">{{ field.description.replace(/<[^>]*>/g, '') }}</small>
	</div>
</template>
