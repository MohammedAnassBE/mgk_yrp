<script setup>
import { computed, ref } from "vue"
import ListPageHeader from "../shell/ListPageHeader.vue"
import ListToolbar from "./ListToolbar.vue"
import ListTabs from "./ListTabs.vue"
import FilterDialog from "./FilterDialog.vue"
import ColumnsDialog from "./ColumnsDialog.vue"
import QuickFilters from "./QuickFilters.vue"
import SplitListView from "./SplitListView.vue"
import { statusPill } from "./statusPill.js"
import { useListView } from "./useListView.js"
import "./list.css"
import { formatFieldValue } from "../document/fieldDisplay.js"

const props = defineProps({
	doctype: { type: String, required: true }, baseFilters: { type: Array, default: () => [] },
	baseOrFilters: { type: Array, default: () => [] },
	extraFields: { type: Array, default: () => [] },
	tabs: { type: Array, default: () => [] }, defaultColumns: { type: Array, default: () => [] },
	defaultOrderBy: { type: String, default: "modified desc" }, title: { type: String, required: true },
	createRoute: { type: String, required: true }, documentRoute: { type: String, required: true },
	relatedDoctypes: { type: Array, default: () => [] },
	statusField: { type: String, default: "docstatus" }, statusLabel: { type: String, default: "Status" },
	columnLabels: { type: Object, default: () => ({}) },
	layout: { type: String, default: "table" }, bulkActions: { type: Array, default: () => [] },
	allowCreate: { type: Boolean, default: true }, backRoute: { type: String, default: "/" }, backLabel: { type: String, default: "Back to books" },
})
const showFilters = ref(false)
const showColumns = ref(false)
const { query, data, search, quickValues, ready, initializing, notice, tabs, fields, quickFields, columns, draft, filterCount, canCreate, sentinel, initialize, refresh, searchChanged, applySearch, quickChanged, applyFilters, clearFilters, sort, direction, tabChanged, columnsSaved, openRow, documentRoute, savePosition, create, loadMore } = useListView(props)
const sortFields = computed(() => columns.value.filter((column) => !column.indicator && !column.clientOnly && column.fieldname !== "name"))
const mobileColumns = computed(() => columns.value.filter((column) => column.fieldname !== "name" && !column.indicator))
const splitQueryKey = computed(() => JSON.stringify([query.tab, query.filters, query.quickFilters, query.search, query.sortField, query.sortDirection]))
function displayValue(row, column) {
	const value = row[column.fieldname]
	if (value === null || value === undefined || value === "") return "—"
	if (column.fieldtype === "Check") return Number(value) ? "Yes" : "No"
	if (column.fieldtype === "Currency") return formatFieldValue(column, value)
	if (["Float", "Int", "Percent"].includes(column.fieldtype)) return Number(value).toLocaleString("en-IN", { maximumFractionDigits: column.fieldtype === "Int" ? 0 : 2 })
	return String(value)
}
function indicator(row) { return statusPill(props.doctype, row) }
function rowClick(event, row) { if (!event.target.closest("a, button, input, select")) openRow(row) }
function ariaSort(column) { return query.sortField === column.fieldname ? (query.sortDirection === "asc" ? "ascending" : "descending") : "none" }
</script>

<template>
	<section class="page list-page book-list-page">
		<ListPageHeader :title="title">
			<RouterLink v-if="backRoute !== '/'" :to="backRoute">← {{ backLabel }}</RouterLink>
			<button v-if="canCreate" class="button primary" type="button" :disabled="!ready" @click="create">+ New</button>
		</ListPageHeader>
		<div v-if="notice" class="list-notice" role="alert">{{ notice }}</div>
		<ListToolbar :search="search" :sort-field="query.sortField" :sort-direction="query.sortDirection" :filter-count="filterCount" :sort-fields="sortFields" :disabled="!ready" @search="searchChanged" @search-now="applySearch" @sort="sort" @direction="direction" @filters="showFilters = true" @clear="clearFilters" @columns="showColumns = true" />
		<QuickFilters v-if="ready" :model-value="quickValues" :fields="quickFields" @update:model-value="quickChanged" />
		<ListTabs :tabs="tabs" :active="query.tab" :counts="data.counts" :total="data.allTotal" :ready="data.countsReady" @change="tabChanged" />
		<div v-if="data.error" class="error-state" role="alert"><h2>Unable to load this list</h2><p>{{ data.error }}</p><button class="button secondary" type="button" @click="ready ? refresh() : initialize()">Retry</button></div>
		<div v-if="initializing || (data.loading && !data.rows.length)" class="loading-state" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true" />Loading {{ title }}…</div>
		<template v-else-if="ready && !data.error">
			<div v-if="!data.rows.length && layout !== 'split'" class="empty-state compact"><i class="pi pi-book" aria-hidden="true" /><h2>No records found</h2><p>Try a different search or clear your filters.</p></div>
			<SplitListView v-else-if="layout === 'split'" :doctype="doctype" :rows="data.rows" :columns="columns" :selected="query.selected || ''"
				:total="data.total" :load-more="loadMore" :document-route="documentRoute" :display-value="displayValue" :query-key="splitQueryKey"
				:bulk-actions="bulkActions" :related-doctypes="relatedDoctypes" :dialog-open="showFilters || showColumns" :loading="data.loading" :save-position="savePosition" :refresh="refresh"
				@update:selected="query.selected = $event" />
			<div v-else class="list-card" :aria-busy="data.loading">
				<div v-if="data.loading" class="list-refreshing" role="status">Refreshing…</div>
				<div class="table-scroll desktop-list"><table>
					<thead><tr><th v-for="column in columns" :key="column.fieldname" :aria-sort="column.indicator || column.clientOnly ? undefined : ariaSort(column)"><span v-if="column.indicator || column.clientOnly">{{ column.label }}</span><button v-else type="button" @click="sort(column.fieldname, true)">{{ column.label }}<span v-if="query.sortField === column.fieldname">{{ query.sortDirection === 'asc' ? ' ↑' : ' ↓' }}</span></button></th><th aria-label="Open record" /></tr></thead>
					<tbody><tr v-for="row in data.rows" :key="row.name" tabindex="0" :aria-label="`Open ${row.name}`" @click="rowClick($event, row)" @keydown.enter.self="openRow(row)">
						<td v-for="column in columns" :key="column.fieldname"><RouterLink v-if="column.fieldname === 'name'" class="record-id" :to="documentRoute(row.name)" @click="savePosition">{{ row.name }}</RouterLink><span v-else-if="column.indicator" class="status" :class="indicator(row).className">{{ indicator(row).label }}</span><span v-else>{{ displayValue(row, column) }}</span></td><td class="row-arrow" aria-hidden="true">›</td>
					</tr></tbody>
				</table></div>
				<div class="mobile-list"><RouterLink v-for="row in data.rows" :key="row.name" class="mobile-row" :to="documentRoute(row.name)" @click="savePosition">
					<div class="mobile-row-head"><strong class="record-id">{{ row.name }}</strong><span class="status" :class="indicator(row).className">{{ indicator(row).label }}</span><span class="row-arrow" aria-hidden="true">›</span></div>
					<dl><div v-for="column in mobileColumns" :key="column.fieldname"><dt>{{ column.label }}</dt><dd>{{ displayValue(row, column) }}</dd></div></dl>
				</RouterLink></div>
			</div>
			<footer class="list-pagination"><span>Showing {{ data.rows.length }} of {{ data.total }}</span><div v-if="data.moreError" class="dialog-error" role="alert">{{ data.moreError }}</div><button v-if="data.rows.length < data.total" class="button secondary" type="button" :disabled="data.loading || data.loadingMore" @click="loadMore">{{ data.loadingMore ? 'Loading…' : data.moreError ? 'Retry loading more' : 'Load more' }}</button></footer>
			<div ref="sentinel" class="list-sentinel" aria-hidden="true" />
		</template>
		<FilterDialog v-model:visible="showFilters" :fields="fields" :filters="query.filters" @apply="applyFilters" />
		<ColumnsDialog v-model:visible="showColumns" :doctype="doctype" :columns="draft" :status-label="statusLabel" @saved="columnsSaved" />
	</section>
</template>
