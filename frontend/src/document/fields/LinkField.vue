<script setup>
import "../../shared/linkSuggestions.css"
import { ref, watch, onBeforeUnmount, getCurrentInstance } from "vue"
import { callRead } from "../../api/client.js"
import { trailingTask } from "../../list/listQuery.js"
import { linkDescription } from "../../list/linkOptions.js"
import { useLinkLabel } from "../../list/useLinkLabel.js"

const props = defineProps({ modelValue: { default: "" }, doctype: String, label: String, inputId: String,
	disabled: Boolean, candidates: { type: Array, default: null }, filters: { type: Object, default: () => ({}) }, query: String,
	searchMethod: String, searchArgs: { type: Object, default: () => ({}) } })
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
const text = ref(props.modelValue || "")
let sequence = 0

async function searchOptions(needle) {
	if (props.candidates !== null) return props.candidates.map((candidate) => typeof candidate === "string" ? { value: candidate } : { ...candidate, value: candidate.value || candidate.name }).filter((row) => row.value.toLowerCase().includes(needle.toLowerCase()))
	if (props.searchMethod) {
		const values = await callRead(props.searchMethod, { ...props.searchArgs, txt: needle, page_len: 20 })
		return values.map((value) => ({ value }))
	}
	return callRead("frappe.desk.search.search_link", { doctype: props.doctype, txt: needle, filters: props.filters, query: props.query, page_length: 20 })
}

async function search() {
	const current = ++sequence
	loading.value = true
	error.value = ""
	try {
		const needle = String(text.value || "")
		const data = await searchOptions(needle)
		if (current !== sequence) return
		results.value = data || []
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
function close() { open.value = false; sequence += 1; loading.value = false; delayedSearch.cancel(); text.value = selectedLabel.value }
function keydown(event) {
	if (event.key === "Escape") close()
	if (["ArrowDown", "ArrowUp"].includes(event.key)) {
		event.preventDefault()
		open.value = true
		active.value = Math.max(0, Math.min(results.value.length - 1, active.value + (event.key === "ArrowDown" ? 1 : -1)))
	}
	if (event.key === "Enter" && open.value && results.value[active.value]) {
		event.preventDefault()
		select(results.value[active.value], true)
	}
}
onBeforeUnmount(close)
watch([open, loading, () => results.value.length], () => {
	if (open.value) suggestionsElement.value?.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
}, { flush: "post" })
watch(() => props.modelValue, (value) => { text.value = value || "" })
watch(selectedLabel, (value) => { if (!open.value) text.value = value })
watch(() => [props.doctype, props.filters, props.candidates, props.searchArgs], () => { close(); results.value = [] }, { deep: true })
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
			:aria-activedescendant="open && results.length ? `${id}-${active}` : undefined"
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
			<div v-else-if="!results.length">No matches</div>
			<ul :id="id" role="listbox" :aria-label="label">
				<li
					v-for="(option, index) in results"
					:id="`${id}-${index}`"
					:key="option.value"
					role="option"
					:aria-selected="index === active"
					@mousedown.prevent="select(option)"
				>
					<strong>{{ option.value }}</strong>
					<small v-if="linkDescription(option)">{{ linkDescription(option) }}</small>
				</li>
			</ul>
		</div>
	</div>
</template>
