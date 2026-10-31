<script setup>
import { onScopeDispose, ref } from "vue"
import Button from "primevue/button"
import Message from "primevue/message"
import ActionDialog from "../shared/ActionDialog.vue"
import MgkItemEditor from "../../item-editor/MgkItemEditor.vue"
import { callMethod } from "../../api/client.js"
import { jobWorkMethods, saveProcessPlan } from "../shared/jobWork.js"

const props = defineProps({ doc: { type: Object, required: true }, names: Array, rows: Array, action: Object })
const emit = defineEmits(["done", "close"])
const planDocument = { doctype: "MGK Process Planning", docstatus: 0 }
const editor = ref(null)
const items = ref(null)
const is_visible = ref(false)
const is_ready = ref(false)
const is_loading = ref(false)
const is_saving = ref(false)
const error = ref("")
let is_disposed = false

async function load() {
	if (is_loading.value || items.value !== null) return
	is_visible.value = true
	is_loading.value = true
	error.value = ""
	try {
		const result = await callMethod(jobWorkMethods.getPlan, { delivery_challan: props.doc.name })
		if (!is_disposed) items.value = result || []
	} catch (cause) { if (!is_disposed) error.value = cause.message }
	finally { if (!is_disposed) is_loading.value = false }
}

async function save() {
	if (is_saving.value || !is_ready.value || !editor.value?.isReady()) return
	is_saving.value = true
	error.value = ""
	try { emit("done", await saveProcessPlan(props.doc.name, editor.value.getItems(), callMethod)) }
	catch (cause) { error.value = cause.message }
	finally { is_saving.value = false }
}
function close() { if (!is_saving.value) emit("close") }
onScopeDispose(() => { is_disposed = true })
</script>

<template>
	<ActionDialog visible header="Update Plan" width="min(1200px, 94vw)" @show="load" @close="close">
		<Message v-if="error" severity="error" :closable="false" class="form-banner">{{ error }}</Message>
		<div v-if="is_loading" class="loading-state" role="status">Loading process plan…</div>
		<button v-else-if="items === null && error" type="button" class="button secondary small" @click="load">Retry</button>
		<div v-if="is_visible && items !== null" class="book-entry">
			<MgkItemEditor ref="editor" :doc="planDocument" mode="plan"
				:editable="!is_saving" :item-details="items" @ready="is_ready = $event" />
		</div>
		<template #footer>
			<Button label="Cancel" severity="secondary" outlined :disabled="is_saving" @click="close" />
			<Button label="Save" :loading="is_saving" :disabled="is_saving || !is_ready" @click="save" />
		</template>
	</ActionDialog>
</template>
