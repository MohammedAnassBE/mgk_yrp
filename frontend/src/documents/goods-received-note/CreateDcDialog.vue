<script setup>
import { computed, ref } from "vue"
import Button from "primevue/button"
import Message from "primevue/message"
import ActionDialog from "../shared/ActionDialog.vue"
import LinkField from "../../document/fields/LinkField.vue"
import { callMethod } from "../../api/client.js"
import { createDcFromSelection, dispatchSelection } from "../shared/jobWork.js"

const props = defineProps({ doc: Object, names: Array, rows: Array, action: Object })
const emit = defineEmits(["done", "close"])
const selection = dispatchSelection(props)
const supplierFilters = { is_company_location: 0, disabled: 0 }
const process = ref("")
const supplier = ref("")
const move_to_head_office = ref(selection.move_to_head_office)
const is_saving = ref(false)
const error = ref("")
const has_required_values = computed(() => Boolean(process.value && supplier.value))

async function save() {
	if (is_saving.value || !has_required_values.value) return
	is_saving.value = true
	error.value = ""
	try {
		emit("done", await createDcFromSelection(selection, { process_name: process.value, supplier: supplier.value,
			move_to_head_office: move_to_head_office.value }, callMethod))
	} catch (cause) { error.value = cause.message }
	finally { is_saving.value = false }
}
function close() { if (!is_saving.value) emit("close") }
</script>

<template>
	<ActionDialog visible header="Create DC" @close="close">
		<form id="create-dc-form" class="form-stack" @submit.prevent="save">
			<Message v-if="error" severity="error" :closable="false" class="form-banner">{{ error }}</Message>
			<div class="form-field">
				<label for="dispatch-process" class="field-label">Process *</label>
				<LinkField v-model="process" doctype="YRP Process" label="Process" input-id="dispatch-process" :disabled="is_saving" />
			</div>
			<div class="form-field">
				<label for="dispatch-supplier" class="field-label">Supplier *</label>
				<LinkField v-model="supplier" doctype="Supplier" label="Supplier" input-id="dispatch-supplier"
					:filters="supplierFilters" :disabled="is_saving" />
			</div>
			<label class="check-field">
				<input v-model="move_to_head_office" type="checkbox" aria-label="Move stock to Head Office"
					:disabled="selection.is_forced || is_saving" :aria-readonly="selection.is_forced" />
				<span>Move stock to Head Office</span>
			</label>
		</form>
		<template #footer>
			<Button label="Cancel" severity="secondary" outlined :disabled="is_saving" @click="close" />
			<Button label="Create DC" type="submit" form="create-dc-form" :loading="is_saving" :disabled="is_saving || !has_required_values" />
		</template>
	</ActionDialog>
</template>
