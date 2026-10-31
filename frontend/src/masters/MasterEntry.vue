<script setup>
import { computed, ref } from "vue"
import { useRoute } from "vue-router"
import Button from "primevue/button"
import Dialog from "primevue/dialog"
import Message from "primevue/message"
import Breadcrumbs from "../shell/Breadcrumbs.vue"
import NoAccess from "../shared/NoAccess.vue"
import FieldControl from "../document/fields/FieldControl.vue"
import ActivityPanel from "../document/ActivityPanel.vue"
import PartyAddresses from "./PartyAddresses.vue"
import UserAccess from "./UserAccess.vue"
import { fieldState } from "../document/fieldConditions.js"
import { masterHeading, safeReturnPath } from "./masterFields.js"
import { useMasterForm } from "./useMasterForm.js"
import "../document/document.css"
import "./masters.css"

const props = defineProps({ master: { type: Object, required: true } })
const route = useRoute()
const pending = ref(null)
const accessBusy = ref(false)
const accessError = ref("")
const { root, doc, metas, meta, sections, loading, busy, dirty, stale, error, messages, isNew, editing, canRead, canDelete,
	variantTemplate, toggle, isDisabled, change, initialize, reload, save, remove } = useMasterForm(props.master, { blocked: () => accessBusy.value || Boolean(accessError.value) })
const back = computed(() => safeReturnPath(route.query.returnTo) || props.master.route)
const heading = computed(() => masterHeading(props.master, doc.value, meta.value, isNew.value))
const toggleEditable = computed(() => toggle.value && editing.value && !fieldState(toggle.value, doc.value, meta.value).readOnly)
function confirm() {
	const action = pending.value
	pending.value = null
	if (action === "delete") remove()
	else reload()
}
</script>

<template>
	<NoAccess v-if="!canRead" />
	<section v-else ref="root" class="page po-document-page book-entry master-book-entry">
		<Breadcrumbs :items="[{ label: 'Manage', to: '/manage' }, { label: master.label, to: master.route }, { label: route.params.name || doc?.name || 'New entry' }]" />
		<div v-if="loading" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" />Loading {{ master.label }}…</div>
		<div v-else-if="variantTemplate" class="form-banner">
			Variants are managed from their template <RouterLink class="record-id" :to="`${master.route}/${encodeURIComponent(variantTemplate)}`">{{ variantTemplate }}</RouterLink>
		</div>
		<template v-else-if="doc && meta">
			<header class="detail-head">
				<div class="book-entry-title"><span class="book-entry-mark cover-masters"><small>MGK</small><strong>{{ master.code }}</strong></span><div><div class="book-entry-kicker">{{ heading.kicker }}</div><h1 class="doc-hero">{{ heading.title }}</h1><p>{{ heading.description }}</p></div></div>
				<div class="head-actions">
					<RouterLink class="button secondary small" :to="back">← Back</RouterLink>
					<Button v-if="dirty && !isNew && editing" label="Discard changes" severity="secondary" outlined size="small" :disabled="busy" @click="pending = 'discard'" />
					<Button v-if="canDelete" label="Delete" severity="secondary" outlined size="small" :disabled="busy" @click="pending = 'delete'" />
					<Button v-if="editing && dirty" label="Save" class="forward-cta" size="small" :loading="busy" :disabled="accessBusy || Boolean(accessError)" @click="save" />
				</div>
			</header>
			<Message v-if="stale" severity="warn" :closable="false" class="form-banner">This master changed elsewhere. <Button label="Reload" size="small" severity="secondary" :disabled="busy" @click="pending = 'reload'" /></Message>
			<Message v-if="error" severity="error" :closable="false" class="form-banner"><p class="server-error">{{ error }}</p></Message>
			<Message v-for="message in messages" :key="message" severity="warn" :closable="false" class="form-banner">{{ message }}</Message>
			<div class="form-layout">
				<div class="form-stack">
					<section v-for="(section, index) in sections" :key="section.key" class="form-section">
						<header class="mgk-card__head"><span class="book-step">{{ index + 1 }}</span><h2>{{ section.label }}</h2></header>
						<div class="form-grid"><FieldControl v-for="field in section.fields" :key="field.fieldname" :field="field" :doc="doc" :meta="meta" :metas="metas" :disabled="busy || !editing" @change="change" /></div>
					</section>
					<section v-if="master.doctype === 'User'" class="form-section">
						<header class="mgk-card__head"><span class="book-step">{{ sections.length + 1 }}</span><h2>Roles and access</h2></header>
						<UserAccess :doc="doc" :disabled="busy || !editing" @change="change" @loading="accessBusy = $event" @error="accessError = $event" />
					</section>
					<PartyAddresses v-if="master.party && !isNew" :doc="doc" :modified="doc.modified" :step="sections.length + 1" :blocked="dirty" />
				</div>
				<aside class="book-entry-aside"><section class="order-summary-card">
					<div class="book-entry-kicker">{{ master.label }}</div><h2>{{ isNew ? 'New entry' : doc.name }}</h2>
					<p>{{ dirty ? 'You have unsaved changes.' : 'All changes saved.' }}</p>
					<p v-if="!editing">{{ master.adminEditOnly ? 'Only a System Manager can edit users and roles.' : 'You have read access to this master.' }}</p>
					<div v-if="toggle" class="master-status"><span class="status" :class="isDisabled ? 'status-disabled' : 'status-active'">{{ isDisabled ? 'Disabled' : 'Active' }}</span><Button v-if="toggleEditable" :label="isDisabled ? 'Enable' : 'Disable'" severity="secondary" outlined size="small" :disabled="busy" @click="change(toggle.fieldname, doc[toggle.fieldname] ? 0 : 1)" /></div>
					<ul class="order-checklist"><li>Complete the required fields</li><li>Review linked records</li><li>Save your changes</li></ul>
				</section></aside>
			</div>
			<ActivityPanel v-if="!isNew" :doctype="master.doctype" :name="doc.name" :record="doc" />
		</template>
		<div v-else class="error-state" role="alert"><h2>Unable to open master</h2><p>{{ error }}</p><button class="button secondary" @click="initialize">Retry</button></div>
		<Dialog :visible="Boolean(pending)" modal :header="pending === 'delete' ? 'Delete master' : 'Discard changes'" :style="{ width: 'min(440px, 94vw)' }" @update:visible="pending = null">
			<p>{{ pending === 'delete' ? `Delete ${doc?.name}?` : 'Discard your changes and reload the saved master?' }}</p>
			<template #footer><Button label="Keep working" severity="secondary" outlined @click="pending = null" /><Button label="Confirm" :severity="pending === 'delete' ? 'danger' : undefined" @click="confirm" /></template>
		</Dialog>
	</section>
</template>
