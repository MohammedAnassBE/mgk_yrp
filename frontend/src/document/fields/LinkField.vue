<script setup>
import "../../shared/linkSuggestions.css"
import { computed, ref, watch, onBeforeUnmount, getCurrentInstance } from "vue"
import { callRead } from "../../api/client.js"
import { trailingTask } from "../../list/listQuery.js"
import { linkRow } from "../../list/linkOptions.js"
import { useLinkLabel } from "../../list/useLinkLabel.js"
import { isTamil, withTamilNames } from "../../shell/displayLanguage.js"
import QuickCreateDialog from "./QuickCreateDialog.vue"
import { canQuickCreate, hasExactMatch, quickCreateLabel } from "./quickCreate.js"

const props = defineProps({ modelValue: { default: "" }, doctype: String, label: String, inputId: String,
	disabled: Boolean, candidates: { type: Array, default: null }, filters: { type: Object, default: () => ({}) }, query: String,
	searchMethod: String, searchArgs: { type: Object, default: () => ({}) },
	createDoctype: String, createDefaults: { type: Object, default: () => ({}) }, createWith: Function, allowCreate: { type: Boolean, default: true } })
const emit = defineEmits(["update:modelValue", "select"])
const { label: selectedLabel, error: labelError } = useLinkLabel(props)
const id = `document-link-${getCurrentInstance().uid}`
const results = ref([])
const open = ref(false)
const loading = ref(false)
const error = ref("")
const active = ref(0)
const inputElement = ref(null)
const suggestionsElement = ref(null)
const text = ref(selectedLabel.value || "")
const creatable = ref(false)
const searchedText = ref(null)
const createText = ref("")
const targetDoctype = computed(() => props.createDoctype || props.doctype)
const createOption = computed(() => {
	const typed = text.value.trim()
	return Boolean(creatable.value && typed && !loading.value && !error.value && searchedText.value === text.value && !hasExactMatch(results.value, typed))
})
const rowCount = computed(() => results.value.length + (createOption.value ? 1 : 0))
let sequence = 0

function matchesText(option, needle) {
	return [option.value, option.label, option.tamil].some((value) => String(value || "").toLowerCase().includes(needle.toLowerCase()))
}

async function searchOptions(needle) {
	if (props.candidates !== null) {
		const options = props.candidates.map((candidate) => typeof candidate === "string" ? { value: candidate } : { ...candidate, value: candidate.value || candidate.name })
		return (await withTamilNames(props.doctype, options)).filter((option) => matchesText(option, needle))
	}
	if (props.searchMethod) {
		const values = await callRead(props.searchMethod, { ...props.searchArgs, txt: needle, page_len: 20 })
		return withTamilNames(props.doctype, (values || []).map((value) => ({ value })))
	}
	const rows = await callRead("frappe.desk.search.search_link", { doctype: props.doctype, txt: needle, filters: props.filters, query: props.query, page_length: 20 })
	return withTamilNames(props.doctype, rows || [])
}

async function search() {
	const current = ++sequence
	loading.value = true
	error.value = ""
	try {
		// A displayed title or Tamil name is not searchable text; search by the stored value instead.
		const needle = String((text.value === selectedLabel.value ? props.modelValue : text.value) || "")
		const searched = text.value
		const [data, canCreate] = await Promise.all([searchOptions(needle),
			props.allowCreate && text.value !== selectedLabel.value ? canQuickCreate(targetDoctype.value) : false])
		if (current !== sequence) return
		results.value = data || []
		creatable.value = canCreate
		searchedText.value = searched
		active.value = 0
	} catch (cause) {
		if (current === sequence) error.value = cause.message
	} finally {
		if (current === sequence) loading.value = false
	}
}
const delayedSearch = trailingTask(search, 200)
function input(value) {
	sequence += 1
	results.value = []
	text.value = value
	if (!value) emit("update:modelValue", "")
	open.value = true
	delayedSearch()
}
function select(option, advance = false) {
	text.value = option.value
	emit("update:modelValue", option.value)
	emit("select", option.value)
	close()
	if (advance) {
		const controls = [...document.querySelectorAll('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')].filter((element) => element.offsetParent && element.tabIndex !== -1)
		controls[controls.indexOf(inputElement.value) + 1]?.focus()
	}
}
function startCreate() {
	createText.value = text.value.trim()
	close()
}
function created(name) {
	createText.value = ""
	select({ value: name })
}
function close() { open.value = false; sequence += 1; loading.value = false; delayedSearch.cancel(); text.value = selectedLabel.value }
function keydown(event) {
	if (event.key === "Escape") close()
	if (["ArrowDown", "ArrowUp"].includes(event.key)) {
		event.preventDefault()
		open.value = true
		active.value = Math.max(0, Math.min(rowCount.value - 1, active.value + (event.key === "ArrowDown" ? 1 : -1)))
	}
	if (event.key === "Enter" && open.value && createOption.value && active.value === results.value.length) {
		event.preventDefault()
		startCreate()
	}
	else if (event.key === "Enter" && open.value && results.value[active.value]) {
		event.preventDefault()
		select(results.value[active.value], true)
	}
}
onBeforeUnmount(close)
watch([open, loading, () => results.value.length], () => {
	if (open.value) suggestionsElement.value?.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
}, { flush: "post" })
watch(() => props.modelValue, () => { text.value = selectedLabel.value || "" })
watch(selectedLabel, (value) => { if (!open.value) text.value = value })
watch(() => [props.doctype, props.filters, props.candidates, props.searchArgs], () => { close(); results.value = []; creatable.value = false }, { deep: true })
defineExpose({ focus: () => inputElement.value?.focus() })
</script>

<template>
	<div class="link-input" @focusout="!$event.currentTarget.contains($event.relatedTarget) && close()">
		<input
			:id="inputId"
			ref="inputElement"
			:value="text"
			:disabled="disabled || (!doctype && !searchMethod)"
			:aria-label="label"
			role="combobox"
			autocomplete="off"
			:aria-expanded="open"
			:aria-controls="id"
			:aria-activedescendant="open && rowCount ? `${id}-${active}` : undefined"
			@input="input($event.target.value)"
			@focus="open = true; search()"
			@keydown="keydown"
		/>
		<small v-if="labelError" role="alert">{{ labelError }}</small>
		<div v-if="open" ref="suggestionsElement" class="link-suggestions">
			<div v-if="loading" role="status">Searching…</div>
			<div v-else-if="error" role="alert">
				{{ error }}
				<button type="button" @click="search">Retry</button>
			</div>
			<div v-else-if="!rowCount">No matches</div>
			<ul :id="id" role="listbox" :aria-label="label">
				<li
					v-for="(option, index) in results"
					:id="`${id}-${index}`"
					:key="option.value"
					role="option"
					:aria-selected="index === active"
					@mousedown.prevent="select(option)"
				>
					<span class="link-option">
						<strong>{{ linkRow(option, isTamil).primary }}</strong>
						<small v-for="line in linkRow(option, isTamil).secondary" :key="line">{{ line }}</small>
					</span>
				</li>
				<li
					v-if="createOption"
					:id="`${id}-${results.length}`"
					class="link-create"
					role="option"
					:aria-selected="active === results.length"
					@mousedown.prevent="startCreate"
				>
					<span aria-hidden="true">+</span> Create a new {{ quickCreateLabel(targetDoctype) }}
				</li>
			</ul>
		</div>
		<QuickCreateDialog v-if="createText" visible :doctype="targetDoctype" :text="createText" :filters="filters"
			:defaults="createDefaults" :create-with="createWith" @close="createText = ''" @created="created" />
	</div>
</template>
