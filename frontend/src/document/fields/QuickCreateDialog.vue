<script setup>
import { ref, watch } from "vue"
import Button from "primevue/button"
import Message from "primevue/message"
import ActionDialog from "../../documents/shared/ActionDialog.vue"
import FieldControl from "./FieldControl.vue"
import { callMethod, getMeta } from "../../api/client.js"
import { missingFields } from "../fieldConditions.js"
import { documentToast, notify } from "../../shared/notify.js"
import { quickCreateDoc, quickCreateForm, quickCreateLabel } from "./quickCreate.js"

const props = defineProps({ visible: Boolean, doctype: { type: String, required: true }, text: { type: String, default: "" },
	filters: { type: [Object, Array], default: () => ({}) } })
const emit = defineEmits(["close", "created"])
const formId = `quick-create-${Math.random().toString(36).slice(2)}`
const form = ref(null)
const draft = ref({})
const isSaving = ref(false)
const error = ref("")
const user = globalThis.window?.frappe?.boot?.user

async function prepare() {
	form.value = null
	error.value = ""
	try {
		const value = quickCreateForm(props.doctype, await getMeta(props.doctype), props.text, props.filters)
		draft.value = value.draft
		form.value = value
	} catch (cause) { error.value = cause.message }
}
async function save() {
	if (isSaving.value || !form.value) return
	const missing = missingFields(form.value.fields, draft.value, form.value.meta, user).map((field) => field.label || field.fieldname)
	if (missing.length) { error.value = `Missing required fields: ${missing.join(", ")}.`; return }
	isSaving.value = true
	error.value = ""
	try {
		const saved = await callMethod("frappe.client.insert", { doc: quickCreateDoc(form.value, draft.value) })
		notify.success(documentToast(saved.name, "created"))
		emit("created", saved.name)
	} catch (cause) { error.value = cause.message }
	finally { isSaving.value = false }
}
function close() { if (!isSaving.value) emit("close") }
watch(() => props.visible, (open) => { if (open) prepare() }, { immediate: true })
</script>

<template>
	<ActionDialog :visible="visible" :header="`New ${quickCreateLabel(doctype)}`" @close="close">
		<form :id="formId" class="form-stack" @submit.prevent="save">
			<Message v-if="error" severity="error" :closable="false" class="form-banner">{{ error }}</Message>
			<FieldControl v-for="field in form?.fields || []" :key="field.fieldname" :field="field" :doc="draft" :meta="form.meta"
				:metas="form.metas" :user="user" :disabled="isSaving" @change="(name, value) => { draft[name] = value }" />
		</form>
		<template #footer>
			<Button label="Cancel" severity="secondary" outlined :disabled="isSaving" @click="close" />
			<Button :label="`Create ${quickCreateLabel(doctype)}`" type="submit" :form="formId" :loading="isSaving" :disabled="isSaving || !form" />
		</template>
	</ActionDialog>
</template>
