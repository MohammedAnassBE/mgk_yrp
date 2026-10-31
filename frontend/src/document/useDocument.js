import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import { callMethod, callDocMethod, getDocument, getMeta } from "../api/client.js"
import { hasPermission } from "../permissions/usePermissions.js"
import { readNewDefaults } from "../list/listState.js"
import { subscribeDoc, onReconnect } from "../realtime/socket.js"
import { amendmentDraft, clone, openMappedDraft, readMappedDraft, stageMappedDraft } from "./mappedDraft.js"
import { metaDefaults } from "./newDocDefaults.js"
import { fieldState, missingFields } from "./fieldConditions.js"
import { documentLayout } from "./documentLayout.js"
import { editorSavePayload } from "../item-editor/editorPayload.js"
import { usePartyDefaults } from "./usePartyDefaults.js"
import { LiveDocument } from "./liveDocument.js"
import { documentModule } from "../documents/registry.js"
import { mutationScope } from "./mutationScope.js"
import { useActionRunner } from "./useActionRunner.js"
import { lifecycleActions } from "./lifecycleActions.js"
import { isSaveShortcut } from "./lifecycle.js"
import { actionToastText, documentToast, notify } from "../shared/notify.js"

export function useDocument(book) {
	const route = useRoute()
	const router = useRouter()
	const doc = ref(null)
	const metas = ref([])
	const loading = ref(true)
	const busy = ref(false)
	const dirty = ref(false)
	const error = ref("")
	const required = ref([])
	const stale = ref(false)
	const itemEditor = ref(null)
	const editorReady = ref(false)
	const fieldsLoading = ref(false)
	const fieldError = ref("")
	const itemsLoading = ref(false)
	const messages = ref([])
	const editorItemCount = ref(null)
	const module = documentModule(book.doctype)
	const fieldEvents = module.createFieldEvents?.({ getDoc: () => doc.value, call: callMethod, callDoc: callDocMethod, getMeta,
		messages: (values) => { messages.value = values },
		setCandidates: (field, values) => { party.candidates.value[field] = values },
		markAuto: (fields) => { party.autoFields.value = [...new Set([...party.autoFields.value, ...fields])] } })
	const extraActions = computed(() => doc.value ? module.actions?.(doc.value, hasPermission) || [] : [])
	const runner = useActionRunner({ reload })
	const meta = computed(() => metas.value.find((entry) => entry.name === book.doctype))
	const layout = computed(() => meta.value ? documentLayout(book.doctype, meta.value) : null)
	const isNew = computed(() => Boolean(doc.value?.__islocal || !doc.value?.name))
	const canWrite = computed(() => hasPermission(book.doctype, isNew.value ? "create" : "write"))
	const editing = computed(() => Boolean(doc.value && Number(doc.value.docstatus) === 0 && canWrite.value))
	let disposed = false
	let loadSequence = 0
	let revision = 0
	let disposers = []
	let routeKey = ""
	let fieldRequests = 0
	let lastAsyncField = ""
	const mutations = mutationScope(() => doc.value, () => route.fullPath, () => disposed)
	const live = new LiveDocument({ reload: () => reload(true), isDirty: () => dirty.value,
		isBusy: () => busy.value || runner.busy.value || loading.value || fieldsLoading.value || itemsLoading.value || party.loading.value, stale: () => { stale.value = true } })
	watch(runner.busy, (is_busy) => { if (!is_busy) live.flush() })

	function canEdit(name) {
		const field = meta.value?.fields.find((field) => field.fieldname === name)
		return Boolean(field && editing.value && !fieldState(module.fieldOverrides?.(field) || field, doc.value, meta.value).readOnly)
	}
	function change(name, value) {
		if (doc.value.is_return && ["from_location", "from_warehouse", "to_location", "to_warehouse", "process_name"].includes(name)) return
		if (doc.value[name] === value) return
		const dependent = { supplier: ["supplier_address", "contact_person"], delivery_location: ["warehouse"], from_location: ["from_warehouse"], to_location: ["to_warehouse"] }[name] || []
		party.autoFields.value = party.autoFields.value.filter((field) => field !== name && !dependent.includes(field))
		for (const field of dependent) if (canEdit(field)) doc.value[field] = null
		doc.value[name] = value
		if (["against_purchase_order", "purchase_order", "delivery_challan"].includes(name)) fieldError.value = ""
		if (["purchase_order", "against_purchase_order"].includes(name)) editorItemCount.value = null
		dirty.value = true
		revision += 1
		if (fieldEvents) runFieldChange(name)
	}
	function update(patch) {
		Object.assign(doc.value, patch)
		dirty.value = true
		revision += 1
	}
	watch(itemsLoading, (loading) => { if (!loading) live.flush() })
	async function runFieldChange(name) {
		const record = doc.value
		const pending = module.asyncFields.includes(name) ? 1 : 0
		if (pending) { error.value = ""; fieldError.value = ""; lastAsyncField = name }
		fieldRequests += pending
		fieldsLoading.value = fieldRequests > 0
		try { await fieldEvents.change(name) }
		catch (cause) { if (!disposed && doc.value === record) (pending ? fieldError : error).value = cause.message }
		finally { fieldRequests -= pending; fieldsLoading.value = fieldRequests > 0; live.flush() }
	}
	async function loadFields() {
		if (!fieldEvents?.load || !editing.value) return
		const record = doc.value
		fieldError.value = ""
		fieldRequests += 1
		fieldsLoading.value = true
		try { await fieldEvents.load() }
		catch (cause) { if (!disposed && doc.value === record) fieldError.value = cause.message }
		finally { fieldRequests -= 1; fieldsLoading.value = fieldRequests > 0; live.flush() }
	}
	function retryFields() { return lastAsyncField ? runFieldChange(lastAsyncField) : loadFields() }
	const party = usePartyDefaults(doc, change, canEdit, editing, module.initialAutoFields)
	watch(() => party.loading.value, (loading) => { if (!loading) live.flush() })
	function itemsChanged(totals) {
		Object.assign(doc.value, totals)
		editorItemCount.value = itemEditor.value?.getItems().reduce((sum, group) => sum + group.items.length, 0) ?? null
		dirty.value = true
		revision += 1
	}

	function listen(name) {
		disposers.forEach((dispose) => dispose())
		disposers = []
		live.pending = false
		if (!name) return
		disposers = [subscribeDoc(book.doctype, name, () => live.update()), onReconnect(() => { live.update(); live.flush() })]
	}

	async function initialize() {
		const current = ++loadSequence
		runner.reset()
		mutations.invalidate()
		busy.value = false
		routeKey = route.fullPath
		loading.value = true
		error.value = ""
		fieldError.value = ""
		messages.value = []
		doc.value = null
		listen(route.params.name)
		try {
			const entries = await getMeta(book.doctype)
			if (disposed || current !== loadSequence) return
			metas.value = entries
			if (!meta.value) throw new Error(`Metadata is missing for ${book.doctype}.`)
			let record
			if (route.params.name) record = await getDocument(book.doctype, route.params.name)
			else {
				if (!hasPermission(book.doctype, "create")) throw new Error("You do not have permission to create this document.")
				const staged = route.query.defaults ? readNewDefaults(route.query.defaults, book.doctype) : null
				const mapped = route.query.draft ? readMappedDraft(route.query.draft, book.doctype) : {}
				const queried = Object.fromEntries((book.queryDefaults || []).filter((field) => route.query[field]).map((field) => [field, String(route.query[field])]))
				record = { ...metaDefaults(meta.value), ...queried, ...staged?.defaults, ...mapped, __islocal: 1, docstatus: 0 }
			}
			if (disposed || current !== loadSequence) return
			apply(record)
			await loadFields()
			if (disposed || current !== loadSequence) return
			if (editing.value) focusStart()
		} catch (cause) { if (current === loadSequence && !disposed) error.value = cause.message }
		finally { if (current === loadSequence && !disposed) { loading.value = false; live.flush() } }
	}

	function apply(record) {
		doc.value = record
		editorItemCount.value = null
		dirty.value = Boolean(record.__islocal)
		stale.value = false
		required.value = []
		fieldError.value = ""
		lastAsyncField = ""
		revision += 1
	}

	async function reload(silent = false) {
		if (isNew.value) return
		const current = ++loadSequence
		const version = revision
		const top = window.scrollY
		try {
			const record = await getDocument(book.doctype, doc.value.name)
			if (disposed || current !== loadSequence) return
			if (silent && (dirty.value || revision !== version)) { stale.value = true; return }
			apply(record)
			await loadFields()
			if (disposed || current !== loadSequence) return
			error.value = ""
			await nextTick()
			window.scrollTo({ top, behavior: "instant" })
		} catch (cause) { if (!disposed && current === loadSequence) error.value = cause.message }
	}

	function payload() {
		if (fieldsLoading.value || itemsLoading.value || party.loading.value) throw new Error("Document details are still loading. Please try again.")
		if (party.error.value) throw new Error(party.error.value)
		if (fieldError.value) throw new Error(fieldError.value)
		const fields = layout.value.itemEditor ? meta.value.fields.filter((field) => field.fieldname !== "items") : meta.value.fields
		required.value = missingFields(fields, doc.value, meta.value).map((field) => field.label)
		if (required.value.length) throw new Error(`Choose the missing required fields: ${required.value.join(", ")}.`)
		if (!layout.value.itemEditor || Number(doc.value.docstatus) !== 0) return clone(doc.value)
		if (!editorReady.value || !itemEditor.value?.isReady()) throw new Error("Items are still loading. Please try again.")
		return editorSavePayload(doc.value, itemEditor.value.getItems())
	}

	async function save() {
		if (busy.value || runner.busy.value || !editing.value || !dirty.value) return
		await perform(async (operation) => {
			const wasNew = isNew.value
			const result = await callMethod("frappe.client.save", { doc: payload() }, (values) => { if (operation.current()) messages.value = values })
			if (!operation.current()) return
			operation.apply(() => apply(result))
			notify.success(documentToast(result.name, "saved"))
			if (wasNew) await router.replace(`${book.routePath}/${encodeURIComponent(result.name)}`)
			else await reload()
		})
	}

	async function perform(action) {
		const operation = mutations.begin()
		busy.value = true
		error.value = ""
		messages.value = []
		try { await action(operation) }
		catch (cause) {
			if (!operation.current()) return
			if (cause.payload?.exc_type === "TimestampMismatchError") stale.value = true
			else if (!required.value.length) error.value = cause.message
			notify.error(cause.message)
		} finally { if (operation.active()) { busy.value = false; live.flush() } }
	}

	async function action(name) {
		if (isActionBlocked(name)) return
		if (name === "save") return save()
		const mapped = extraActions.value.find((entry) => entry.key === name)
		if (mapped) return runMappedAction(mapped)
		return runDocumentAction(name)
	}

	function isActionBlocked(name) {
		if (name === "submit" && fieldError.value) { error.value = fieldError.value; return true }
		return busy.value || runner.busy.value || fieldsLoading.value || itemsLoading.value
	}

	function runMappedAction(mapped) {
		if (mapped.run || mapped.dialog) return runner.run(mapped, { doc: doc.value })
		if (mapped.to) return router.push(mapped.to)
		return perform((operation) => openMappedDraft(mapped, doc.value.name, { call: callMethod,
			isCurrent: operation.current, navigate: (target) => router.push(target) }))
	}

	async function runDocumentAction(name) {
		if (!["submit", "cancel", "delete", "amend"].includes(name)) { error.value = `Unknown document action: ${name}`; return }
		if (!hasPermission(book.doctype, name)) return
		const lifecycle = lifecycleActions(doc.value, meta.value, hasPermission).find((entry) => entry.key === name)
		if (["submit", "cancel"].includes(name) && !lifecycle) return
		await perform((operation) => mutateDocument(name, lifecycle, operation))
	}

	async function mutateDocument(name, lifecycle, operation) {
		if (name === "amend") return amendDocument(operation)
		const call = (method, args) => callMethod(method, args, (values) => { if (operation.current()) messages.value = values })
		const docName = doc.value.name
		const outcome = lifecycle ? await lifecycle.run({ doc: doc.value }, { call, isCurrent: operation.current })
			: await call("frappe.client.delete", { doctype: book.doctype, name: docName })
		if (!operation.current()) return
		if (name === "delete") {
			notify.success(documentToast(docName, "deleted"))
			return router.push(book.listPath || book.routePath)
		}
		const result = outcome?.doc
		if (!result) return
		notify.success(actionToastText(outcome))
		if (name === "cancel" && book.doctype === "MGK Purchase Invoice") {
			result.__onload = { ...result.__onload, valuation_pending: true }
		}
		operation.apply(() => apply(result))
		await reload()
	}

	async function amendDocument(operation) {
		const latest = await getDocument(book.doctype, doc.value.name)
		if (!operation.current()) return
		operation.apply(() => apply(latest))
		if (latest.__onload?.valuation_pending || ["Reversing", "Reopening"].includes(latest.reopen_status)) throw new Error("Wait for valuation or reopening to finish before amending.")
		const draft = stageMappedDraft(amendmentDraft(latest, metas.value))
		await router.push({ path: `${book.routePath}/new`, query: { draft } })
		notify.success(`Amending ${latest.name}`)
	}

	async function focusStart() {
		await nextTick()
		document.querySelector('.book-entry .form-stack input:not(:disabled), .book-entry .form-stack select:not(:disabled)')?.focus()
	}
	function keydown(event) { if (isSaveShortcut(event)) event.preventDefault() }
	watch(() => route.fullPath, () => { if (routeKey !== route.fullPath) initialize() })
	onMounted(() => { window.addEventListener("keydown", keydown); initialize() })
	onBeforeUnmount(() => {
		disposed = true
		mutations.invalidate()
		loadSequence += 1
		live.dispose()
		disposers.forEach((dispose) => dispose())
		window.removeEventListener("keydown", keydown)
	})
	return { doc, meta, metas, layout, loading, busy, runner, dirty, editing, error, required, stale, itemEditor, editorReady,
		isNew, canWrite, party, fieldsLoading, fieldError, retryFields, itemsLoading, messages, extraActions, editorItemCount, change, update, itemsChanged, initialize, reload, save, action }
}
