<script setup>
import { ref, watch } from "vue"
import Button from "primevue/button"
import Message from "primevue/message"
import ActionDialog from "../../documents/shared/ActionDialog.vue"
import FieldControl from "./FieldControl.vue"
import { callMethod, getMeta } from "../../api/client.js"
import { missingFields } from "../fieldConditions.js"
import { documentToast, notify } from "../../shared/notify.js"
import { fullFormUrl, quickCreateDoc, quickCreateForm, quickCreateLabel } from "./quickCreate.js"

const props = defineProps({ visible: Boolean, doctype: { type: String, required: true }, text: { type: String, default: "" },
	filters: { type: [Object, Array], default: () => ({}) }, defaults: { type: Object, default: () => ({}) }, createWith: Function })
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
		const value = quickCreateForm(props.doctype, await getMeta(props.doctype), props.text, { filters: props.filters, defaults: props.defaults })
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
		const doc = { doctype: props.doctype, ...quickCreateDoc(form.value, draft.value) }
		if (props.createWith) emit("created", await props.createWith(doc))
		else {
			const saved = await callMethod("frappe.client.insert", { doc })
			notify.success(documentToast(saved.name, "created"))
			emit("created", saved.name)
		}
	} catch (cause) { error.value = cause.message }
	finally { isSaving.value = false }
}
function openFullForm() {
	globalThis.window.open(fullFormUrl(props.doctype, draft.value), "_blank")
	emit("close")
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
			<Button class="quick-create-full" label="Open full form ↗" link :disabled="isSaving || !form" @click="openFullForm" />
			<Button label="Cancel" severity="secondary" outlined :disabled="isSaving" @click="close" />
			<Button :label="`Create ${quickCreateLabel(doctype)}`" type="submit" :form="formId" :loading="isSaving" :disabled="isSaving || !form" />
		</template>
	</ActionDialog>
</template>

<style scoped>
.quick-create-full { margin-right: auto; }
</style>
