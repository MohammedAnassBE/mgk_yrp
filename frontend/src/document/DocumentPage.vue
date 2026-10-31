<script setup>
import { computed } from "vue"
import { useRoute } from "vue-router"
import Message from "primevue/message"
import Button from "primevue/button"
import Breadcrumbs from "../shell/Breadcrumbs.vue"
import NoAccess from "../shared/NoAccess.vue"
import DocumentHeader from "./DocumentHeader.vue"
import DocumentActions from "./DocumentActions.vue"
import ActionHost from "./ActionHost.vue"
import DetailsPanel from "./DetailsPanel.vue"
import ActivityPanel from "./ActivityPanel.vue"
import DocumentSummary from "./DocumentSummary.vue"
import ConnectedRecords from "./ConnectedRecords.vue"
import { usePresentation } from "../documents/usePresentation.js"
import FieldControl from "./fields/FieldControl.vue"
import MgkItemEditor from "../item-editor/MgkItemEditor.vue"
import InvoiceItems from "../documents/purchase-invoice/InvoiceItems.vue"
import { documentModule } from "../documents/registry.js"
import { hasPermission } from "../permissions/usePermissions.js"
import { visibleFields } from "./fieldConditions.js"
import { connectedDocuments, summaryFields } from "./documentLayout.js"
import { formatFieldValue } from "./fieldDisplay.js"
import { statusPill } from "../list/statusPill.js"
import { useDocument } from "./useDocument.js"
import "../list/list.css"
import "./document.css"

const props = defineProps({ book: { type: Object, required: true } })
const route = useRoute()
const { doc, meta, metas, layout, loading, busy, runner, dirty, editing, error, required, stale, itemEditor, editorReady,
	isNew, canWrite, party, fieldsLoading, fieldError, retryFields, itemsLoading, messages, extraActions, editorItemCount, change, update, itemsChanged, initialize, reload, action } = useDocument(props.book)
const { summary: documentSummary, facts: viewFacts, connections, fieldHints, statusRecord, loading: factsLoading, error: factsError, retry: retryFacts } = usePresentation(doc, editorItemCount)
const { candidates, autoFields, error: partyError, loading: partyLoading, retry: retryParty } = party
const disabled = computed(() => busy.value || runner.busy.value || itemsLoading.value || !editing.value || !canWrite.value)
const summary = computed(() => visibleFields(summaryFields.map((name) => meta.value?.fields.find((field) => field.fieldname === name)).filter(Boolean), doc.value, meta.value))
const valuationStatus = computed(() => doc.value?.__onload?.valuation_status)
const module = documentModule(props.book.doctype)
const intro = computed(() => doc.value ? module.intro?.(doc.value) : null)
const valuationChip = computed(() => doc.value ? module.valuationChip?.(doc.value) : null)
const status = computed(() => statusPill(props.book.doctype, statusRecord.value || doc.value))
const connected = computed(() => connectedDocuments(doc.value, meta.value).filter((link) => hasPermission(link.doctype)))
const tables = computed(() => meta.value?.fields.filter((field) => field.fieldtype === "Table" && ['items', 'outputs'].includes(field.fieldname)) || [])
const facts = computed(() => viewFacts.value || visibleFields(layout.value.paper, doc.value, meta.value).map((field) => ({ label: field.label, value: fieldValue(field) })))
function fieldValue(field) {
	const value = doc.value[field.fieldname]
	return formatFieldValue(field, value)
}
</script>

<template>
	<NoAccess v-if="!hasPermission(book.doctype)" />
	<section v-else class="page po-document-page book-entry">
		<Breadcrumbs
			:items="[{ label: book.label, to: book.listPath || book.routePath }, { label: route.params.name || doc?.name || 'New entry' }]"
		/>
		<div v-if="loading" class="loading-state" role="status">
			<i class="pi pi-spin pi-spinner" />
			Loading document…
		</div>
		<template v-else-if="doc && layout">
			<DocumentHeader
				:book="book"
				:doc="doc"
				:is-new="isNew"
				:dirty="dirty"
			>
				<div>
					<RouterLink class="button secondary small" :to="book.listPath || book.routePath">← Back</RouterLink>
					<DocumentActions
						:doc="doc"
						:meta="meta"
						:is-new="isNew"
						:dirty="dirty"
						:busy="busy || runner.busy.value || fieldsLoading || itemsLoading || partyLoading"
						:blocked="Boolean(fieldError)"
						:extra-actions="extraActions"
						:editing="editing"
						@action="action"
						@discard="reload()"
					/>
				</div>
			</DocumentHeader>
			<Message v-if="intro" :severity="intro.severity" :closable="false" class="form-banner">{{ intro.text }}</Message>
			<ActionHost :runner="runner" />
			<Message v-for="message in messages" :key="message" severity="warn" :closable="false" class="form-banner">{{ message }}</Message>
			<Message
				v-if="stale"
				severity="warn"
				:closable="false"
				class="form-banner stale-banner"
			>
				This document was changed elsewhere —
				<Button
					label="Reload"
					severity="secondary"
					outlined
					size="small"
					:disabled="busy"
					@click="reload()"
				/>
			</Message>
			<Message
				v-if="required.length"
				severity="warn"
				:closable="false"
				class="form-banner"
			>Missing required fields: {{ required.join(', ') }}.</Message>
			<Message
				v-if="error"
				severity="error"
				:closable="false"
				class="form-banner"
			>
				<strong>Unable to complete this action</strong>
				<p class="server-error">{{ error }}</p>
			</Message>
			<Message
				v-if="partyError"
				severity="error"
				:closable="false"
				class="form-banner"
			>
				{{ partyError }}
				<Button
					label="Retry defaults"
					size="small"
					severity="secondary"
					@click="retryParty"
				/>
			</Message>
			<p v-if="fieldsLoading || factsLoading" class="field-help" role="status">Loading document details…</p>
			<Message v-if="fieldError" severity="error" :closable="false" class="form-banner">
				{{ fieldError }} <Button label="Retry details" size="small" severity="secondary" @click="retryFields" />
			</Message>
			<Message v-if="factsError" severity="error" :closable="false" class="form-banner">
				{{ factsError }} <Button label="Retry details" size="small" severity="secondary" @click="retryFacts" />
			</Message>
			<div :class="editing ? 'form-layout' : 'po-saved-layout'">
				<div class="form-stack">
					<section v-if="editing" class="form-section">
						<header class="mgk-card__head">
							<span class="book-step">1</span>
							<h2>{{ layout.heading }}</h2>
						</header>
						<div class="form-grid">
							<FieldControl
								v-for="field in layout.paper"
								:key="field.fieldname"
								:field="field"
								:doc="doc"
								:meta="meta"
								:metas="metas"
								:disabled="disabled"
								:candidates="candidates[field.fieldname] ?? null"
								@change="change"
							/>
						</div>
					</section>
					<section v-else class="po-order-overview">
						<div class="overview-head">
							<span class="saved-book" :class="book.cover">{{ book.code }}</span>
							<div>
								<div class="book-entry-kicker">{{ book.label }}</div>
								<h2>{{ layout.overviewTitle || doc.name }}</h2>
							</div>
						</div>
						<div class="po-facts">
							<div v-for="(fact, index) in facts" :key="index" class="po-fact">
								<span>{{ fact.label }}</span>
								<RouterLink v-if="fact.to && hasPermission(fact.doctype)" :to="fact.to"><strong>{{ fact.value || '—' }}</strong></RouterLink>
								<strong v-else>{{ fact.value ?? '—' }}</strong>
							</div>
						</div>
					</section>
					<section v-if="layout.itemEditor" class="child-editor" :class="{ 'po-saved-items': !editing }">
						<header class="child-editor-head po-section-title">
							<span class="book-step">2</span>
							<div>
								<h2>{{ layout.itemsTitle }}</h2>
								<small>{{ editing ? layout.help : layout.readOnlyHelp || layout.help }}</small>
							</div>
							<span v-if="!editing" class="count-chip">{{ doc.items?.length || 0 }} rows</span>
						</header>
						<MgkItemEditor
							ref="itemEditor"
							:doc="doc"
							:editable="!disabled && !fieldsLoading && Number(doc.docstatus) === 0"
							@ready="editorReady = $event"
							@loaded="editorItemCount = $event"
							@change="itemsChanged"
						/>
					</section>
					<InvoiceItems v-if="layout.invoiceRows" :doc="doc" :meta="meta" :metas="metas" :disabled="busy || !editing"
						@change="change" @update="update" @loading="itemsLoading = $event" @messages="messages = $event" />
					<section
						v-for="(field, index) in layout.itemEditor || layout.invoiceRows ? [] : tables"
						:key="field.fieldname"
						class="child-editor"
					>
						<header class="child-editor-head">
							<span class="book-step">{{ index + 2 }}</span>
							<div>
								<h2>{{ field.fieldname === 'outputs' ? 'Linked GRN outputs' : layout.itemsTitle }}</h2>
								<small>{{ layout.help }}</small>
							</div>
						</header>
						<div class="table-field-body">
							<FieldControl
								:field="field"
								:doc="doc"
								:meta="meta"
								:metas="metas"
								:disabled="disabled"
								@change="change"
							/>
						</div>
					</section>
				</div>
				<aside :class="editing ? 'book-entry-aside' : 'po-saved-side'">
					<DetailsPanel
						v-if="(editing || !viewFacts) && !layout.gridForm"
						:fields="layout.panel"
						:doc="doc"
						:meta="meta"
						:metas="metas"
						:candidates="candidates"
						:auto-fields="autoFields"
						:hints="fieldHints"
						:disabled="disabled"
						@change="change"
					/>
					<p v-if="partyLoading" role="status" class="field-help">Loading party defaults…</p>
					<DocumentSummary v-if="documentSummary" :summary="documentSummary" :editing="editing" :book="book" />
					<section v-else class="po-totals-card">
						<h2>Summary</h2>
						<div v-for="(field, index) in summary" :key="field.fieldname" class="summary-line" :class="{ 'grand-total': index === summary.length - 1 }">
							<span>{{ field.label }}</span>
							<strong>{{ formatFieldValue(field, doc[field.fieldname] ?? 0) }}</strong>
						</div>
					</section>
					<section class="po-progress-card">
						<h2>Document status</h2>
						<p><span class="status" :class="status.className">{{ status.label }}</span></p>
						<p v-if="doc.__onload?.valuation_pending">Valuation is pending.</p>
						<p v-if="valuationChip"><span class="status" :class="valuationChip.className">{{ valuationChip.label }}</span></p>
						<p v-else-if="valuationStatus">Valuation: {{ valuationStatus }}</p>
						<p v-if="doc.reopen_status">{{ doc.reopen_status }}</p>
						<p v-if="doc.close_status">Close status: {{ doc.close_status }}</p>
						<RouterLink v-for="link in connected" :key="`${link.doctype}:${link.name}`" :to="link.to" class="connected-record">
							<small>{{ link.label }}</small><strong>{{ link.name }} ›</strong>
						</RouterLink>
						<ConnectedRecords :connections="connections" :record="doc" />
						<ul v-if="editing && !documentSummary" class="order-checklist">
							<li>Check the party and date</li>
							<li>Enter item quantities</li>
							<li>Review missing details before saving</li>
						</ul>
					</section>
				</aside>
			</div>
			<ActivityPanel
				v-if="!isNew"
				:doctype="book.doctype"
				:name="doc.name"
				:record="doc"
			/>
		</template>
		<div v-else class="error-state" role="alert">
			<h2>{{ error.startsWith('Draft expired') ? 'Draft expired' : 'Unable to open document' }}</h2>
			<p>{{ error }}</p>
			<RouterLink class="button secondary" :to="book.listPath || book.routePath">← Back to {{ book.label }}</RouterLink>
			<button type="button" class="button secondary" @click="initialize">Retry</button>
		</div>
	</section>
</template>
