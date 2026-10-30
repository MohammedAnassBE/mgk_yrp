<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { callRead } from "../api/client.js"
import { hasPermission } from "../permissions/usePermissions.js"
import { subscribeDoctype, onReconnect } from "../realtime/socket.js"
import { trailingTask } from "../list/listQuery.js"
import { stageNewDefaults } from "../list/listState.js"
import { partyLinkFilters, linkedPartyDraft, partyReturnPath } from "./masterFields.js"
import { getMaster } from "./mastersConfig.js"

const props = defineProps({ doc: Object, modified: String, step: Number, blocked: Boolean })
const router = useRouter()
const groups = [
	{ doctype: "Address", label: "Addresses", singular: "address", master: "addresses", fields: ["name", "address_title", "address_type", "address_line1", "address_line2", "city", "state", "pincode", "country"] },
	{ doctype: "Contact", label: "Contacts", singular: "contact", master: "contacts", fields: ["name", "full_name", "email_id", "mobile_no", "phone"] },
].filter((group) => hasPermission(group.doctype))
const rows = ref({})
const loading = ref(true)
const error = ref("")
let sequence = 0
let disposers = []
const partyPath = () => partyReturnPath(getMaster(props.doc.doctype === "Supplier" ? "suppliers" : "agents"), props.doc.name)
async function load() {
	const current = ++sequence
	loading.value = true
	error.value = ""
	try {
		const result = await Promise.all(groups.map((group) => callRead("frappe.client.get_list", {
			doctype: group.doctype, fields: group.fields, filters: partyLinkFilters(props.doc.doctype, props.doc.name),
			order_by: "modified desc, name asc", limit_page_length: 0,
		})))
		if (current === sequence) rows.value = Object.fromEntries(groups.map((group, index) => [group.doctype, result[index]]))
	} catch (cause) { if (current === sequence) error.value = cause.message }
	finally { if (current === sequence) loading.value = false }
}
async function open(group, name) {
	if (props.blocked) { error.value = "Save the party before opening an address or contact."; return }
	try {
		const path = `${getMaster(group.master).route}/${name ? encodeURIComponent(name) : "new"}`
		const query = { returnTo: partyPath() }
		if (!name) query.defaults = stageNewDefaults(group.doctype, linkedPartyDraft(props.doc.doctype, props.doc.name), partyPath())
		await router.push({ path, query })
	} catch (cause) { error.value = cause.message }
}
function detail(group, row) {
	return group.doctype === "Address" ? [row.address_line1, row.address_line2, row.city, row.state, row.pincode, row.country].filter(Boolean).join(", ")
		: [row.email_id, row.mobile_no || row.phone].filter(Boolean).join(" · ")
}
const refresh = trailingTask(load, 500)
watch(() => props.modified, refresh)
onMounted(() => { disposers = groups.map((group) => subscribeDoctype(group.doctype, refresh)); disposers.push(onReconnect(load)); load() })
onBeforeUnmount(() => { sequence++; refresh.cancel(); disposers.forEach((dispose) => dispose()) })
</script>

<template>
	<section class="form-section">
		<header class="mgk-card__head"><span class="book-step">{{ step }}</span><h2>Addresses and contacts</h2></header>
		<div class="master-party-body">
			<div v-if="loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />Loading linked records…</div>
			<div v-else-if="error" class="error-state" role="alert"><p>{{ error }}</p><button class="button secondary" @click="load">Retry</button></div>
			<template v-else>
				<p v-if="!groups.length" class="empty-state">You do not have access to addresses or contacts.</p>
				<section v-for="group in groups" :key="group.doctype">
					<div class="manage-foot"><h3>{{ group.label }}</h3><button v-if="hasPermission(group.doctype, 'create')" class="button secondary small" :disabled="blocked" @click="open(group)">Add {{ group.singular }}</button></div>
					<p v-if="!rows[group.doctype]?.length" class="field-help">No linked {{ group.label.toLowerCase() }} yet.</p>
					<div v-for="row in rows[group.doctype]" :key="row.name" class="master-party-row"><a :href="`/web/manage/${group.master}/${encodeURIComponent(row.name)}`" @click.prevent="open(group, row.name)">{{ row.address_title || row.full_name || row.name }} ›</a><p>{{ detail(group, row) }}</p></div>
				</section>
			</template>
		</div>
	</section>
</template>
