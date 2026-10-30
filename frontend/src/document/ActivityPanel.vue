<template>
	<section v-if="isSaved" class="document-activity" :aria-labelledby="headingId" :aria-busy="loading">
		<header class="document-activity__header">
			<button type="button" class="document-activity__toggle" :aria-expanded="expanded" :aria-controls="bodyId" @click="toggle">
				<i :class="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" aria-hidden="true" />
				<h2 :id="headingId">Activity</h2>
				<span v-if="countLabel" class="document-activity__count">{{ countLabel }}</span>
			</button>
			<span v-if="!expanded && activity?.modified?.at" class="document-activity__summary">
				Last modified {{ formatDisplayDatetime(activity.modified.at) }}
			</span>
		</header>
		<div v-if="expanded" :id="bodyId" class="document-activity__body">
			<p v-if="error" class="document-activity__error" role="alert">
				{{ error }}
				<Button label="Retry" severity="secondary" text size="small" @click="load" />
			</p>
			<p v-else-if="loading && !activity" class="document-activity__muted" role="status">Loading activity…</p>
			<template v-else-if="activity">
				<p class="document-activity__stamp document-activity__stamp--modified">
					<strong>{{ activity.modified.user_name }}</strong> modified this
					<span class="document-activity__time">· {{ formatDisplayDatetime(activity.modified.at) }}</span>
				</p>
				<ol v-if="entries.length" class="document-activity__versions" aria-label="Version history">
					<li v-for="entry in entries" :key="entry.name" class="document-activity__version">
						<div class="document-activity__version-head">
							<strong>{{ entry.user_name || entry.user }}</strong>
							<span class="document-activity__time">· {{ formatDisplayDatetime(entry.at) }}</span>
						</div>
						<ul class="document-activity__lines">
							<li v-for="(line, index) in describeActivityEntry(entry)" :key="index">
								<template v-for="(segment, segmentIndex) in line" :key="segmentIndex"><strong v-if="segment.strong">{{ segment.text }}</strong><template v-else>{{ segment.text }}</template></template>
							</li>
						</ul>
					</li>
				</ol>
				<p v-else-if="!hasMore" class="document-activity__muted">No changes recorded since creation.</p>
				<Button
					v-if="hasMore"
					class="document-activity__more"
					label="Show more"
					icon="pi pi-angle-down"
					severity="secondary"
					text
					size="small"
					:loading="loadingMore"
					@click="loadMore"
				/>
				<p class="document-activity__stamp document-activity__stamp--created">
					<strong>{{ activity.created.user_name }}</strong>
					{{ activity.created.amended_from ? "amended this from" : "created this" }}
					<strong v-if="activity.created.amended_from">{{ activity.created.amended_from }}</strong>
					<span class="document-activity__time">· {{ formatDisplayDatetime(activity.created.at) }}</span>
				</p>
			</template>
		</div>
	</section>
</template>

<script setup>
import Button from "primevue/button"
import { computed, ref, watch } from "vue"

import { callRead } from "../api/client.js"
import { formatDisplayDatetime } from "./activityFormat.js"
import { activityRefreshKey, describeActivityEntry, isSavedDocumentName } from "./activityFormat.js"

const getDocumentActivity = (doctype, name, { start, pageLength }) => callRead("mgk_yrp.web.activity.get_document_activity", { doctype, name, start, page_length: pageLength })

const props = defineProps({
	doctype: { type: String, required: true },
	name: { type: String, default: "" },
	record: { type: Object, default: null },
	pageLength: { type: Number, default: 10 },
	initialPage: { type: Object, default: null },
})

const isSaved = computed(() => Boolean(props.doctype) && isSavedDocumentName(props.name))
const headingId = computed(() => `document-activity-${String(props.name).replace(/[^A-Za-z0-9_-]+/g, "-")}`)
const bodyId = computed(() => `${headingId.value}-body`)
const expanded = ref(false)
const activity = ref(null)
const entries = ref([])
const hasMore = ref(false)
const nextStart = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref("")
let sequence = 0
let usedInitialPage = null
let stale = true

const countLabel = computed(() => activity.value ? `${entries.value.length}${hasMore.value ? "+" : ""}` : "")

async function fetchPage(start) {
	return getDocumentActivity(props.doctype, props.name, { start, pageLength: props.pageLength })
}

function applyPage(result, append) {
	activity.value = { created: result.created, modified: result.modified }
	entries.value = append ? [...entries.value, ...result.versions] : result.versions
	hasMore.value = Boolean(result.has_more)
	nextStart.value = result.next_start
}

async function load() {
	const current = ++sequence
	stale = false
	error.value = ""
	if (!isSaved.value) {
		activity.value = null
		entries.value = []
		return
	}
	if (props.initialPage && props.initialPage !== usedInitialPage) {
		usedInitialPage = props.initialPage
		applyPage(props.initialPage, false)
		loading.value = false
		return
	}
	loading.value = true
	try {
		const result = await fetchPage(0)
		if (current === sequence) applyPage(result, false)
	} catch (reason) {
		if (current === sequence) error.value = reason?.message || "Activity could not be loaded."
	} finally {
		if (current === sequence) loading.value = false
	}
}

async function loadMore() {
	const current = sequence
	loadingMore.value = true
	try {
		const result = await fetchPage(nextStart.value)
		if (current === sequence) applyPage(result, true)
	} catch (reason) {
		if (current === sequence) error.value = reason?.message || "Older activity could not be loaded."
	} finally {
		loadingMore.value = false
	}
}

function toggle() {
	expanded.value = !expanded.value
	if (expanded.value && stale) load()
}

function resetForDocument() {
	sequence += 1
	expanded.value = false
	activity.value = null
	entries.value = []
	hasMore.value = false
	loading.value = false
	error.value = ""
}
function refresh() {
	const hasFreshInitialPage = props.initialPage && props.initialPage !== usedInitialPage
	if (expanded.value || hasFreshInitialPage) load()
	else stale = true
}

watch(() => [props.doctype, props.name, activityRefreshKey(props.record)], ([doctype, name, key], previous = []) => {
	const sameDocument = previous[0] === doctype && previous[1] === name
	if (!sameDocument) resetForDocument()
	if (!sameDocument || (previous[2] && key !== previous[2])) refresh()
}, { immediate: true })
</script>

<style scoped>
.document-activity {
	margin-top: var(--activity-space, 16px);
	border: 1px solid var(--color-line);
	border-radius: var(--radius);
	background: var(--color-card);
	color: var(--color-text);
	font-size: var(--type-body);
}

.document-activity__header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--activity-gap, 8px);
	padding: 8px 12px;
}

.document-activity__toggle {
	display: inline-flex;
	align-items: center;
	gap: var(--activity-gap, 8px);
	padding: 0;
	border: 0;
	background: none;
	color: var(--color-muted);
	font: inherit;
	cursor: pointer;
}

.document-activity__toggle h2 {
	margin: 0;
	font-size: var(--type-body);
	font-weight: var(--activity-weight, 750);
	letter-spacing: .02em;
}

.document-activity__count {
	padding: 0 6px;
	border-radius: 999px;
	background: var(--color-count);
	color: var(--color-muted);
	font-size: var(--type-caption);
}

.document-activity__summary,
.document-activity__time,
.document-activity__muted {
	color: var(--color-muted);
}

.document-activity__body {
	display: grid;
	gap: var(--activity-gap, 8px);
	padding: 4px 12px 12px;
	border-top: 1px solid var(--color-inner-line);
}

.document-activity__body p {
	margin: 0;
}

.document-activity__stamp {
	padding-top: 8px;
}

.document-activity__error {
	display: flex;
	align-items: center;
	gap: var(--activity-gap, 8px);
	color: var(--color-danger);
}

.document-activity__versions {
	display: grid;
	gap: 10px;
	margin: 0;
	padding: 0 0 0 12px;
	border-left: 2px solid var(--color-line);
	list-style: none;
}

.document-activity__version-head {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

.document-activity__lines {
	margin: 2px 0 0;
	padding-left: 16px;
	color: var(--color-muted);
	overflow-wrap: anywhere;
}

.document-activity__more {
	justify-self: start;
}
</style>
