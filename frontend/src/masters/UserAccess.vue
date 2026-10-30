<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import MultiSelect from "primevue/multiselect"
import InputText from "primevue/inputtext"
import Button from "primevue/button"
import { callRead } from "../api/client.js"
import { isSystemManager } from "./mastersConfig.js"

const props = defineProps({ doc: Object, disabled: Boolean })
const emit = defineEmits(["change", "loading", "error"])
const roles = ref([])
const profiles = ref([])
const search = ref("")
const loading = ref(false)
const error = ref("")
const selectedProfiles = computed(() => (props.doc.role_profiles || []).map((row) => row.role_profile))
const selectedRoles = computed(() => new Set((props.doc.roles || []).map((row) => row.role)))
const canEdit = computed(() => isSystemManager() && !props.disabled)
const visibleRoles = computed(() => [...new Set([...roles.value, ...selectedRoles.value])].sort().filter((role) => role.toLowerCase().includes(search.value.toLowerCase())))
let sequence = 0
let disposed = false
function state(value, message = "") { loading.value = value; error.value = message; emit("loading", value); emit("error", message) }
function roleRows(values) { return values.map((role) => props.doc.roles?.find((row) => row.role === role) || { doctype: "Has Role", role }) }
function toggleRole(role, checked) {
	if (!canEdit.value || selectedProfiles.value.length || loading.value) return
	const values = new Set(selectedRoles.value)
	if (checked) values.add(role)
	else values.delete(role)
	emit("change", "roles", roleRows([...values]))
}
async function updateProfiles(values) {
	if (!canEdit.value || loading.value) return
	const current = ++sequence
	state(true)
	try {
		const docs = await Promise.all(values.map((name) => callRead("frappe.client.get", { doctype: "Role Profile", name })))
		if (disposed || current !== sequence) return
		const rows = values.map((role_profile) => props.doc.role_profiles?.find((row) => row.role_profile === role_profile) || { doctype: "User Role Profile", role_profile })
		emit("change", "role_profiles", rows)
		if (values.length) emit("change", "roles", roleRows([...new Set(docs.flatMap((doc) => doc.roles.map((row) => row.role)))]))
		state(false)
	} catch (cause) { if (!disposed && current === sequence) state(false, cause.message) }
}
async function load() {
	if (!isSystemManager()) return
	const current = ++sequence
	state(true)
	try {
		const [roleOptions, profileOptions] = await Promise.all([
			callRead("frappe.core.doctype.user.user.get_all_roles"),
			callRead("frappe.client.get_list", { doctype: "Role Profile", fields: ["name"], order_by: "name asc", limit_page_length: 0 }),
		])
		if (disposed || current !== sequence) return
		roles.value = roleOptions
		profiles.value = profileOptions.map((row) => row.name)
		state(false)
	} catch (cause) { if (!disposed && current === sequence) state(false, cause.message) }
}
onMounted(load)
onBeforeUnmount(() => { disposed = true; sequence++ })
</script>

<template>
	<div class="access-editor">
		<div v-if="loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />Loading access options…</div>
		<div v-if="error" class="error-state" role="alert"><p>{{ error }}</p><Button label="Retry access options" severity="secondary" outlined @click="load" /></div>
		<label><span class="field-label">Role profiles</span>
			<MultiSelect :model-value="selectedProfiles" :options="[...new Set([...profiles, ...selectedProfiles])]" filter display="chip" aria-label="Role profiles" fluid :disabled="!canEdit || loading" @update:model-value="updateProfiles" />
			<small class="field-help">A profile applies its complete role set when the User is saved.</small>
		</label>
		<label><span class="field-label">Search roles</span><InputText v-model="search" aria-label="Search roles" fluid /></label>
		<small class="field-help">{{ selectedRoles.size }} roles selected{{ selectedProfiles.length ? ' · Roles come from the selected profiles.' : '' }}</small>
		<div class="role-checklist">
			<label v-for="role in visibleRoles" :key="role" class="role-option" :class="{ selected: selectedRoles.has(role) }"><input type="checkbox" :checked="selectedRoles.has(role)" :disabled="!canEdit || loading || Boolean(selectedProfiles.length)" @change="toggleRole(role, $event.target.checked)" /><span>{{ role }}</span></label>
		</div>
		<p v-if="!loading && !visibleRoles.length" class="empty-state">No matching roles.</p>
	</div>
</template>
