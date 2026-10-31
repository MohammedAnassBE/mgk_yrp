<script setup>
import "../shared/linkSuggestions.css"
import { ref, watch, onBeforeUnmount, getCurrentInstance } from "vue"
import { searchLinks } from "./listApi.js"
import { trailingTask } from "./listQuery.js"
import { linkDescription } from "./linkOptions.js"
import { useLinkLabel } from "./useLinkLabel.js"

const props = defineProps({ modelValue: { default: "" }, doctype: { type: String, required: true }, label: { type: String, default: "Link value" }, placeholder: String, inputId: String })
const emit = defineEmits(["update:modelValue", "select"])
const { label: selectedLabel, error: labelError } = useLinkLabel(props)
const generatedId = `link-${getCurrentInstance().uid}`
const results = ref([])
const open = ref(false)
const loading = ref(false)
const error = ref("")
const active = ref(0)
let sequence = 0

async function search() {
	const current = ++sequence
	loading.value = true
	error.value = ""
	try {
		const data = await searchLinks(props.doctype, String(props.modelValue || ""))
		if (current !== sequence) return
		results.value = data
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
	emit("update:modelValue", value)
	open.value = true
	delayedSearch()
}
function select(option) {
	emit("update:modelValue", option.value)
	emit("select", option.value)
	close()
}
function close() { open.value = false; sequence += 1; loading.value = false; delayedSearch.cancel() }
function keydown(event) {
	if (event.key === "Escape") close()
	if (["ArrowDown", "ArrowUp"].includes(event.key)) {
		event.preventDefault()
		open.value = true
		active.value = Math.max(0, Math.min(results.value.length - 1, active.value + (event.key === "ArrowDown" ? 1 : -1)))
	}
	if (event.key === "Enter" && open.value && results.value[active.value]) {
		event.preventDefault()
		select(results.value[active.value])
	}
}
onBeforeUnmount(close)
watch(() => props.doctype, () => { close(); results.value = [] })
</script>

<template>
	<div class="link-input" @focusout="!$event.currentTarget.contains($event.relatedTarget) && close()">
		<input :id="inputId" :value="open ? modelValue : selectedLabel" :aria-label="label" :placeholder="placeholder" role="combobox" autocomplete="off" :aria-expanded="open" :aria-controls="generatedId" :aria-activedescendant="open && results.length ? `${generatedId}-${active}` : undefined" @input="input($event.target.value)" @focus="open = true; search()" @keydown="keydown" />
		<small v-if="labelError" role="alert">{{ labelError }}</small>
		<div v-if="open" class="link-suggestions">
			<div v-if="loading" role="status">Searching…</div>
			<div v-else-if="error" role="alert">{{ error }} <button type="button" @click="search">Retry</button></div>
			<div v-else-if="!results.length">No matches</div>
			<ul :id="generatedId" role="listbox" :aria-label="label">
				<li v-for="(option, index) in results" :id="`${generatedId}-${index}`" :key="option.value" role="option" :aria-selected="index === active" @mousedown.prevent="select(option)">
					<strong>{{ option.value }}</strong><small v-if="linkDescription(option)">{{ linkDescription(option) }}</small>
				</li>
			</ul>
		</div>
	</div>
</template>
