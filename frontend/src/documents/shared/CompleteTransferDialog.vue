<script setup>
import { ref } from "vue"
import Button from "primevue/button"
import Message from "primevue/message"
import ActionDialog from "./ActionDialog.vue"
import LinkField from "../../document/fields/LinkField.vue"
import TransferItems from "./TransferItems.vue"
import { callMethod } from "../../api/client.js"
import { completeTransfer, transferDestination, transferItems } from "./transit.js"

const props = defineProps({ doc: { type: Object, required: true }, names: Array, rows: Array, action: Object })
const emit = defineEmits(["done", "close"])
const destination = transferDestination(props.doc)
const warehouse = ref(destination.warehouse)
const items = ref(transferItems(props.doc, true))
const is_saving = ref(false)
const error = ref("")

async function save() {
	if (is_saving.value) return
	is_saving.value = true
	error.value = ""
	try { emit("done", await completeTransfer(props.doc, warehouse.value, items.value, callMethod)) }
	catch (cause) { error.value = cause.message }
	finally { is_saving.value = false }
}
function close() { if (!is_saving.value) emit("close") }
</script>

<template>
	<ActionDialog visible header="Complete Transfer" width="min(960px, 94vw)" @close="close">
		<form id="complete-transfer-form" class="form-stack" @submit.prevent="save">
			<Message v-if="error" severity="error" :closable="false" class="form-banner">{{ error }}</Message>
			<div class="form-field">
				<label for="transfer-warehouse" class="field-label">Receiving Warehouse *</label>
				<LinkField v-model="warehouse" doctype="Warehouse" label="Receiving Warehouse" input-id="transfer-warehouse"
					:filters="destination.filters" :disabled="is_saving" />
			</div>
			<TransferItems :rows="items" editable :busy="is_saving" @quantity="(row, value) => row.qty = value" />
		</form>
		<template #footer>
			<Button label="Cancel" severity="secondary" outlined :disabled="is_saving" @click="close" />
			<Button label="Complete Transfer" type="submit" form="complete-transfer-form" :loading="is_saving" :disabled="is_saving" />
		</template>
	</ActionDialog>
</template>
