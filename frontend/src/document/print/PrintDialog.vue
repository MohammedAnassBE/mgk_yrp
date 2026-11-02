<script setup>
import { computed, onMounted, onScopeDispose, ref } from "vue"
import Button from "primevue/button"
import Message from "primevue/message"
import Select from "primevue/select"
import ActionDialog from "../../documents/shared/ActionDialog.vue"
import { downloadPrintPdf, getPrintOptions } from "../../api/client.js"
import { notify } from "../../shared/notify.js"
import { isTamil } from "../../shell/displayLanguage.js"
import { buildPrintPdfArgs, buildPrintUrl, openPrintUrl, preferredPrintFormat } from "./print.js"

const props = defineProps({ doc: { type: Object, required: true }, names: Array, rows: Array, action: Object })
const emit = defineEmits(["done", "close"])
const formats = ref([])
const letter_heads = ref([])
const format = ref("")
const letter_head = ref("")
const is_loading = ref(true)
const is_saving_pdf = ref(false)
const error = ref("")
const is_ready = computed(() => !is_loading.value && Boolean(format.value))
const selection = () => ({ doctype: props.doc.doctype, name: props.doc.name, format: format.value, letterHead: letter_head.value || "" })
let is_disposed = false

onMounted(async () => {
	try {
		const options = await getPrintOptions(props.doc.doctype, props.doc.name)
		if (is_disposed) return
		formats.value = options.formats
		letter_heads.value = options.letter_heads
		format.value = preferredPrintFormat(options, props.doc.doctype, isTamil.value)
		letter_head.value = options.default_letter_head || ""
	} catch (cause) { if (!is_disposed) error.value = cause.message }
	finally { if (!is_disposed) is_loading.value = false }
})
onScopeDispose(() => { is_disposed = true })

function print() {
	if (!is_ready.value || is_saving_pdf.value) return
	if (!openPrintUrl(buildPrintUrl(selection()))) { error.value = "Please allow pop-ups to print."; return }
	emit("close")
}
async function savePdf() {
	if (!is_ready.value || is_saving_pdf.value) return
	is_saving_pdf.value = true
	error.value = ""
	try {
		await downloadPrintPdf(buildPrintPdfArgs(selection()))
		emit("close")
	} catch (cause) { error.value = cause.message; notify.error(cause.message) }
	finally { is_saving_pdf.value = false }
}
function close() { if (!is_saving_pdf.value) emit("close") }
</script>

<template>
	<ActionDialog visible header="Print document" width="min(440px, 94vw)" @close="close">
		<div class="form-stack">
			<Message v-if="error" severity="error" :closable="false" class="form-banner">{{ error }}</Message>
			<div v-if="is_loading" class="loading-state" role="status">Loading print options…</div>
			<template v-else-if="formats.length">
				<label class="form-field"><span class="field-label">Print Format</span>
					<Select v-model="format" :options="formats" :disabled="is_saving_pdf" aria-label="Print Format" fluid /></label>
				<label class="form-field"><span class="field-label">Letter Head</span>
					<Select v-model="letter_head" :options="letter_heads" :disabled="is_saving_pdf" aria-label="Letter Head" show-clear placeholder="No letter head" fluid /></label>
			</template>
		</div>
		<template #footer>
			<Button label="Save as PDF" icon="pi pi-file-pdf" severity="secondary" outlined :loading="is_saving_pdf" :disabled="!is_ready || is_saving_pdf" @click="savePdf" />
			<Button label="Print" icon="pi pi-print" :disabled="!is_ready || is_saving_pdf" @click="print" />
		</template>
	</ActionDialog>
</template>
