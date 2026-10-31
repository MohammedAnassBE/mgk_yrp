import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import { callMethod, callRead, getDocument, getMeta } from "../api/client.js"
import { hasPermission } from "../permissions/usePermissions.js"
import { subscribeDoc, onReconnect } from "../realtime/socket.js"
import { LiveDocument } from "../document/liveDocument.js"
import { mutationScope } from "../document/mutationScope.js"
import { clone } from "../document/mappedDraft.js"
import { metaDefaults } from "../document/newDocDefaults.js"
import { missingFields } from "../document/fieldConditions.js"
import { readNewDefaults } from "../list/listState.js"
import { canEditMaster } from "./mastersConfig.js"
import { derivedItemValues } from "./itemConversions.js"
import { disableField, disabledValue, dynamicLinkFields, masterSections, safeReturnPath } from "./masterFields.js"

export function useMasterForm(master, options = {}) {
	const route = useRoute()
	const router = useRouter()
	const doc = ref(null)
	const metas = ref([])
	const loading = ref(true)
	const busy = ref(false)
	const dirty = ref(false)
	const stale = ref(false)
	const error = ref("")
	const messages = ref([])
	const root = ref(null)
	const meta = computed(() => metas.value.find((entry) => entry.name === master.doctype))
	const isNew = computed(() => !doc.value?.name || Boolean(doc.value.__islocal))
	const variantTemplate = computed(() => master.doctype === "Item" ? doc.value?.variant_of : null)
	const canRead = hasPermission(master.doctype, master.permission)
	const editing = computed(() => !variantTemplate.value && canEditMaster(master) && hasPermission(master.doctype, isNew.value ? "create" : "write"))
	const canDelete = computed(() => !variantTemplate.value && !isNew.value && canEditMaster(master) && hasPermission(master.doctype, "delete"))
	const sections = computed(() => !variantTemplate.value && doc.value && meta.value ? masterSections(master, meta.value, doc.value) : [])
	const toggle = computed(() => meta.value && disableField(meta.value))
	const isDisabled = computed(() => toggle.value && doc.value && disabledValue(toggle.value, doc.value))
	let disposed = false
	let sequence = 0
	let revision = 0
	let disposers = []
	const mutations = mutationScope(() => doc.value, () => route.fullPath, () => disposed)
	const live = new LiveDocument({ reload: () => reload(true), isDirty: () => dirty.value,
		isBusy: () => busy.value || loading.value, stale: () => { stale.value = true } })

	function change(name, value) {
		if (!editing.value || busy.value) return
		doc.value[name] = value
		if (master.doctype === "Item") Object.assign(doc.value, derivedItemValues(name, value, isNew.value))
		if (master.doctype === "Item" && name === "stock_uom") {
			for (const row of doc.value.mgk_process_conversions || []) row.from_uom = value
		}
		dirty.value = true
		revision++
	}
	function apply(record) {
		doc.value = record
		dirty.value = Boolean(record.__islocal)
		stale.value = false
		revision++
	}
	function listen(name) {
		if (disposed) return
		disposers.forEach((dispose) => dispose())
		live.pending = false
		disposers = name ? [subscribeDoc(master.doctype, name, () => live.update()), onReconnect(() => live.update())] : []
	}
	async function prepareMetadata() {
		const entries = (await getMeta(master.doctype)).map((entry) => entry.name === master.doctype
			? { ...entry, fields: entry.fields.map((field) => ({ ...field, ...master.fieldOverrides?.[field.fieldname] })) } : entry)
		if (!entries.some((entry) => entry.name === master.doctype)) throw new Error(`Metadata is missing for ${master.doctype}.`)
		if (!entries.some((entry) => entry.name === "Dynamic Link")) return entries
		const options = await callRead("frappe.desk.search.search_link", { doctype: "DocType", txt: "",
			query: "frappe.contacts.address_and_contact.filter_dynamic_link_doctypes",
			filters: { fieldtype: "HTML", fieldname: master.doctype === "Address" ? "address_html" : "contact_html" }, page_length: 1000 })
		return entries.map((entry) => entry.name === "Dynamic Link" ? dynamicLinkFields(entry, options.map((row) => row.value)) : entry)
	}
	async function initialize() {
		if (!canRead) return
		const current = ++sequence
		mutations.invalidate()
		busy.value = false
		loading.value = true
		error.value = ""
		doc.value = null
		listen(route.params.name)
		try {
			const entries = await prepareMetadata()
			if (disposed || current !== sequence) return
			metas.value = entries
			const defaults = route.query.defaults ? readNewDefaults(route.query.defaults, master.doctype) : null
			if (!route.params.name && (!editing.value || !hasPermission(master.doctype, "create"))) throw new Error("You do not have permission to create this master.")
			const record = route.params.name ? await getDocument(master.doctype, route.params.name)
				: { ...metaDefaults(meta.value), ...master.defaults, ...defaults?.defaults }
			if (disposed || current !== sequence) return
			apply(record)
		} catch (cause) { if (!disposed && current === sequence) error.value = cause.message }
		finally { if (!disposed && current === sequence) { loading.value = false; live.flush() } }
		await nextTick()
		if (!disposed && current === sequence && editing.value) root.value?.querySelector('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [role="combobox"]:not([aria-disabled="true"])')?.focus()
	}
	async function reload(silent = false) {
		if (isNew.value) return initialize()
		const current = ++sequence
		const version = revision
		try {
			const record = await getDocument(master.doctype, doc.value.name)
			if (disposed || current !== sequence) return
			if (silent && (dirty.value || version !== revision)) { stale.value = true; return }
			apply(record)
			error.value = ""
		} catch (cause) { if (!disposed && current === sequence) error.value = cause.message }
	}
	async function perform(action) {
		if (busy.value) return
		const operation = mutations.begin()
		busy.value = true
		error.value = ""
		messages.value = []
		try { await action(operation) }
		catch (cause) {
			if (!operation.current()) return
			error.value = cause.message
			if (cause.payload?.exc_type === "TimestampMismatchError") stale.value = true
		} finally { if (operation.active()) { busy.value = false; live.flush() } }
	}
	async function save() {
		if (!editing.value || !dirty.value) return
		return perform(async (operation) => {
			if (options.blocked?.()) throw new Error("Resolve the access options error or wait for them to finish loading before saving.")
			const fields = sections.value.flatMap((section) => section.fields)
			const missing = missingFields(fields, doc.value, meta.value).map((field) => field.label)
			if (missing.length) throw new Error(`Missing required fields: ${missing.join(", ")}.`)
			const wasNew = isNew.value
			const method = wasNew ? "frappe.client.insert" : "frappe.client.save"
			const saved = await callMethod(method, { doc: clone(doc.value) }, (values) => { if (operation.current()) messages.value = values })
			if (!operation.current()) return
			operation.apply(() => apply(saved))
			busy.value = false
			const returnTo = safeReturnPath(route.query.returnTo)
			if (returnTo) return router.push(returnTo)
			if (wasNew) await router.replace(`${master.route}/${encodeURIComponent(saved.name)}`)
			if (operation.current()) listen(saved.name)
		})
	}
	async function remove() {
		if (!canDelete.value) return
		return perform(async (operation) => {
			await callMethod("frappe.client.delete", { doctype: master.doctype, name: doc.value.name })
			if (!operation.current()) return
			await router.push(safeReturnPath(route.query.returnTo) || master.route)
		})
	}
	function keydown(event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save() } }
	onMounted(() => { window.addEventListener("keydown", keydown); initialize() })
	onBeforeUnmount(() => { disposed = true; sequence++; live.dispose(); disposers.forEach((dispose) => dispose()); window.removeEventListener("keydown", keydown) })
	return { root, doc, metas, meta, sections, loading, busy, dirty, stale, error, messages, isNew, editing, canRead, canDelete,
		variantTemplate, toggle, isDisabled, change, initialize, reload, save, remove }
}
