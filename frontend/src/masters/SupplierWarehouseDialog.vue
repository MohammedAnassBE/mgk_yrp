<script setup>
import { computed, ref, watch } from "vue"
import Button from "primevue/button"
import InputText from "primevue/inputtext"
import Message from "primevue/message"
import ActionDialog from "../documents/shared/ActionDialog.vue"
import LinkField from "../document/fields/LinkField.vue"
import { callMethod, callRead } from "../api/client.js"
import { documentToast, notify } from "../shared/notify.js"
import { supplierWarehouseDraft } from "./masterFields.js"

const props = defineProps({ visible: Boolean, supplier: { type: Object, required: true } })
const emit = defineEmits(["close", "created"])
const draft = ref({})
const companyFixed = ref(false)
const isSaving = ref(false)
const error = ref("")
const parentFilters = computed(() => ({ is_group: 1, disabled: 0, ...(draft.value.company ? { company: draft.value.company } : {}) }))

async function prepare() {
	error.value = ""
	try {
		const companies = await callRead("frappe.client.get_list", { doctype: "Company", fields: ["name"], limit_page_length: 2 })
		draft.value = { parent_warehouse: "", company: "", ...supplierWarehouseDraft(props.supplier, companies) }
		companyFixed.value = companies.length === 1
	} catch (cause) { error.value = cause.message }
}
async function save() {
	if (isSaving.value) return
	const missing = [["warehouse_name", "Warehouse name"], ["company", "Company"]].filter(([field]) => !String(draft.value[field] || "").trim())
	if (missing.length) { error.value = `Missing required fields: ${missing.map(([, label]) => label).join(", ")}.`; return }
	isSaving.value = true
	error.value = ""
	try {
		const saved = await callMethod("frappe.client.insert", { doc: { doctype: "Warehouse", ...draft.value, warehouse_name: draft.value.warehouse_name.trim() } })
		notify.success(documentToast(saved.name, "created"))
		draft.value = { ...draft.value, warehouse_name: "" }
		emit("created", saved)
	} catch (cause) { error.value = cause.message; notify.error(cause.message) }
	finally { isSaving.value = false }
}
function close() { if (!isSaving.value) emit("close") }
watch(() => props.visible, (open) => { if (open) prepare() }, { immediate: true })
</script>

<template>
	<ActionDialog :visible="visible" header="Create Warehouse" @close="close">
		<form id="supplier-warehouse-form" class="form-stack" @submit.prevent="save">
			<Message v-if="error" severity="error" :closable="false" class="form-banner">{{ error }}</Message>
			<p class="field-help">The warehouse is linked to {{ supplier.supplier_name || supplier.name }}. Create as many as you need.</p>
			<div class="form-field">
				<label for="supplier-warehouse-name" class="field-label">Warehouse name <span class="required">*</span></label>
				<InputText id="supplier-warehouse-name" v-model="draft.warehouse_name" :disabled="isSaving" fluid />
			</div>
			<div class="form-field">
				<label for="supplier-warehouse-company" class="field-label">Company <span class="required">*</span></label>
				<LinkField v-model="draft.company" doctype="Company" label="Company" input-id="supplier-warehouse-company" :disabled="isSaving || companyFixed" />
			</div>
			<div class="form-field">
				<label for="supplier-warehouse-parent" class="field-label">Parent warehouse</label>
				<LinkField v-model="draft.parent_warehouse" doctype="Warehouse" label="Parent warehouse" input-id="supplier-warehouse-parent"
					:filters="parentFilters" :disabled="isSaving" />
			</div>
		</form>
		<template #footer>
			<Button label="Close" severity="secondary" outlined :disabled="isSaving" @click="close" />
			<Button label="Create Warehouse" type="submit" form="supplier-warehouse-form" :loading="isSaving" :disabled="isSaving" />
		</template>
	</ActionDialog>
</template>
