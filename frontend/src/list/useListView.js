import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import { getMeta, getCounts } from "../api/client.js"
import { hasPermission } from "../permissions/usePermissions.js"
import { subscribeDoctype, onReconnect } from "../realtime/socket.js"
import { filterFields } from "./filterFields.js"
import { getUserColumns, columnDraft, visibleColumns, listColumnMeta } from "./listColumns.js"
import { getRows } from "./listApi.js"
import { initialListData, ListLoader } from "./listLoader.js"
import { activeFilters, equalityDefaults, orderedTabs, quickFilterTuples, restoreQuickDateRanges, trailingTask, PAGE_SIZE } from "./listQuery.js"
import { listStateKey, readListState, saveListState, stageNewDefaults } from "./listState.js"
import { indicatorFields } from "./statusPill.js"
import { routeFilters } from "./routeFilters.js"
import { replaceEqualityFilter } from "./clickFilters.js"

export function useListView(props) {
	const route = useRoute()
	const router = useRouter()
	const stateKey = listStateKey(props.doctype, route.path)
	const [defaultField, defaultDirection] = props.defaultOrderBy.split(/\s+/)
	const query = reactive({ filters: [], quickFilters: {}, search: "", tab: "all", sortField: defaultField, sortDirection: defaultDirection })
	const search = ref("")
	const quickValues = ref({})
	const meta = ref({ fields: [] })
	const draft = ref([])
	const ready = ref(false)
	const initializing = ref(false)
	const notice = ref("")
	const data = reactive(initialListData())
	const tabs = computed(() => orderedTabs(props.tabs))
	const fields = computed(() => filterFields(meta.value))
	const quickFields = computed(() => fields.value.filter((field) => field.in_standard_filter))
	const columns = computed(() => visibleColumns(draft.value, props.statusLabel).map((column) => ({ ...column, label: props.columnLabels[column.fieldname] || column.label })))
	const filterCount = computed(() => query.filters.length + quickFilterTuples(quickFields.value, query.quickFilters).length)
	const canCreate = hasPermission(props.doctype, "create") && props.allowCreate !== false
	const sentinel = ref(null)
	let observer
	let disposed = false
	let initializationSequence = 0
	let pendingRefresh = false
	let savedScroll = 0
	let savedLimit = PAGE_SIZE
	let disposers = []
	const currentQuery = () => JSON.parse(JSON.stringify({ ...query, baseFilters: props.baseFilters, baseOrFilters: props.baseOrFilters, tabs: props.tabs, quickFields: quickFields.value }))
	const fetchFields = () => [...new Set(["name", "docstatus", ...(props.extraFields || []), ...columns.value.filter((column) => !column.indicator && !column.clientOnly).map((column) => column.fieldname), ...indicatorFields(props.doctype, hasPermission("MGK Purchase Invoice"))])]
	const splitFields = () => props.layout === "split" ? meta.value.fields.filter((field) => ["modified", "supplier", "from_location", "to_location", "po_date", "posting_date", "total_qty", "total_output_qty", "total_amount", "grand_total", "total_declared_value", "total_dc_value", "amount"].includes(field.fieldname)).map((field) => field.fieldname).concat("modified") : []
	const loader = new ListLoader({ doctype: props.doctype, getRows, getCounts, query: currentQuery, fields: () => [...new Set([...fetchFields(), ...splitFields()])], state: data })
	let pendingMore
	function loadMore() {
		if (!pendingMore) pendingMore = loader.more().finally(() => { pendingMore = null })
		return pendingMore
	}

	function restore() {
		try {
			const saved = readListState(stateKey)
			if (saved) {
				const { loadedCount, scrollTop, ...values } = saved
				Object.assign(query, values)
				savedScroll = scrollTop
				savedLimit = loadedCount
			}
		} catch (cause) { notice.value = `List position could not be restored: ${cause.message}` }
		const tab = route.query.tab ?? query.tab
		query.tab = tabs.value.some((candidate) => candidate.key === tab) ? tab : "all"
		applyRouteFilters()
		search.value = query.search
		quickValues.value = { ...query.quickFilters }
	}
	function applyRouteFilters() {
		const filters = routeFilters(props.doctype, route.query)
		if (!filters) return
		Object.assign(query, { filters, quickFilters: {}, search: "", tab: "all" })
		search.value = ""
		quickValues.value = {}
	}

	async function initialize() {
		const sequence = ++initializationSequence
		loader.dispose()
		initializing.value = true
		ready.value = false
		data.error = ""
		try {
			const [metas, saved] = await Promise.all([getMeta(props.doctype), getUserColumns(props.doctype)])
			if (disposed || sequence !== initializationSequence) return
			meta.value = metas.find((entry) => entry.name === props.doctype)
			if (!meta.value) throw new Error(`Metadata is missing for ${props.doctype}.`)
			Object.assign(query, restoreQuickDateRanges(quickFields.value, query))
			quickValues.value = { ...query.quickFilters }
			draft.value = columnDraft(listColumnMeta(meta.value), props.defaultColumns, saved, props.statusField)
			if (!fields.value.some((field) => field.fieldname === query.sortField)) query.sortField = defaultField
			ready.value = true
			const loaded = await loader.load(savedLimit)
			if (disposed || sequence !== initializationSequence) return
			initializing.value = false
			if (loaded) await restoreScroll(savedScroll)
			if (pendingRefresh) { pendingRefresh = false; liveRefresh() }
		} catch (cause) {
			if (!disposed && sequence === initializationSequence) data.error = cause.message
		} finally {
			if (!disposed && sequence === initializationSequence) initializing.value = false
		}
	}

	async function restoreScroll(top) {
		await nextTick()
		if (!disposed) window.scrollTo({ top, behavior: "instant" })
	}

	async function refresh() {
		if (!ready.value || initializing.value) { pendingRefresh = true; return }
		const top = window.scrollY
		const loaded = await loader.load(Math.max(PAGE_SIZE, data.rows.length))
		if (loaded) await restoreScroll(top)
	}
	const liveRefresh = trailingTask(refresh, 500)
	function reconnect() { liveRefresh.cancel(); refresh() }
	async function reloadQuery() {
		if (!ready.value) return
		savedLimit = PAGE_SIZE
		savedScroll = 0
		await loader.load()
	}
	const applySearch = () => { delayedSearch.cancel(); query.search = search.value; reloadQuery() }
	const delayedSearch = trailingTask(applySearch, 300)
	function searchChanged(value) { search.value = value; delayedSearch() }
	const applyQuick = trailingTask(() => { query.quickFilters = { ...quickValues.value }; reloadQuery() }, 1000)
	function quickChanged(values) { quickValues.value = values; applyQuick() }
	function applyFilters(filters) { query.filters = filters; reloadQuery() }
	function filterBy(filter) {
		const [fieldname, , value] = filter
		if (!quickFields.value.some((field) => field.fieldname === fieldname)) return applyFilters(replaceEqualityFilter(query.filters, filter))
		applyQuick.cancel()
		quickValues.value = { ...quickValues.value, [fieldname]: value }
		query.quickFilters = { ...quickValues.value }
		query.filters = query.filters.filter(([field, operator]) => !(field === fieldname && operator === "="))
		reloadQuery()
	}
	function removeFilter(index) { applyFilters(query.filters.filter((_filter, position) => position !== index)) }
	function clearFilters() {
		applyQuick.cancel()
		query.filters = []
		query.quickFilters = {}
		quickValues.value = {}
		if (route.query.purchase_order) {
			const { purchase_order, ...query } = route.query
			router.replace({ query })
		}
		reloadQuery()
	}
	function sort(field, toggle = false) {
		if (toggle) query.sortDirection = query.sortField === field && query.sortDirection === "desc" ? "asc" : "desc"
		query.sortField = field
		reloadQuery()
	}
	function direction() { query.sortDirection = query.sortDirection === "asc" ? "desc" : "asc"; reloadQuery() }
	function tabChanged(key) { router.replace({ query: { ...route.query, tab: key } }) }
	watch(() => route.query.tab, (key) => {
		const next = tabs.value.some((tab) => tab.key === key) ? key : "all"
		if (query.tab === next) return
		query.tab = next
		reloadQuery()
	})
	watch(() => route.query.purchase_order, (value) => {
		if (!value) return
		applyRouteFilters()
		reloadQuery()
	})
	async function columnsSaved() {
		try {
			const saved = await getUserColumns(props.doctype)
			if (disposed) return
			draft.value = columnDraft(listColumnMeta(meta.value), props.defaultColumns, saved, props.statusField)
			await refresh()
		} catch (cause) { data.error = cause.message }
	}
	function savePosition() {
		try { saveListState(stateKey, { ...query, loadedCount: data.rows.length, scrollTop: window.scrollY }) }
		catch (cause) { notice.value = `List position could not be saved: ${cause.message}`; console.warn(notice.value) }
	}
	function documentRoute(name) { return `${props.documentRoute}/${encodeURIComponent(name)}` }
	function openRow(row) { savePosition(); router.push(documentRoute(row.name)) }
	function create() {
		if (!canCreate) return
		try {
			const defaults = equalityDefaults(activeFilters(currentQuery()), fields.value)
			const token = stageNewDefaults(props.doctype, defaults, route.fullPath)
			savePosition()
			router.push({ path: props.createRoute, query: { defaults: token } })
		} catch (cause) { notice.value = `New document could not be opened: ${cause.message}` }
	}
	function observe() {
		observer?.disconnect()
		if (!sentinel.value || data.error || data.moreError || data.loading || data.loadingMore || data.rows.length >= data.total) return
		observer?.observe(sentinel.value)
	}
	watch(() => [sentinel.value, initializing.value, data.rows.length, data.total, data.loading, data.loadingMore, data.error, data.moreError], observe, { flush: "post" })
	onMounted(() => {
		restore()
		if (query.tab !== route.query.tab) tabChanged(query.tab)
		if (typeof IntersectionObserver !== "undefined") observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) loadMore()
		}, { rootMargin: "0px 0px 240px 0px" })
		disposers = [...new Set([props.doctype, ...props.relatedDoctypes])].map((doctype) => subscribeDoctype(doctype, liveRefresh))
		disposers.push(onReconnect(reconnect))
		initialize()
	})
	onBeforeUnmount(() => {
		savePosition()
		disposed = true
		loader.dispose()
		initializationSequence += 1
		observer?.disconnect()
		delayedSearch.cancel()
		applyQuick.cancel()
		liveRefresh.cancel()
		disposers.forEach((dispose) => dispose())
	})
	return { meta, filterBy, removeFilter, query, data, search, quickValues, ready, initializing, notice, tabs, fields, quickFields, columns, draft, filterCount, canCreate, sentinel, initialize, refresh, searchChanged, applySearch, quickChanged, applyFilters, clearFilters, sort, direction, tabChanged, columnsSaved, openRow, documentRoute, savePosition, create, loadMore }
}
