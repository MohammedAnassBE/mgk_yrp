import { computed, onBeforeUnmount, ref, watch } from "vue"
import { callRead, getMeta } from "../api/client.js"
import { displayName } from "../shell/displayLanguage.js"

export function useLinkLabel(props) {
	const englishLabel = ref(props.modelValue || "")
	const error = ref("")
	let sequence = 0
	watch(() => [props.doctype, props.modelValue], async ([doctype, value]) => {
		const current = ++sequence
		englishLabel.value = value || ""
		error.value = ""
		if (!doctype || !value) return
		try {
			const meta = (await getMeta(doctype)).find((entry) => entry.name === doctype)
			const titleField = Number(meta?.show_title_field_in_link) === 1 && meta.title_field ? meta.title_field : ""
			if (current !== sequence || !titleField) return
			const record = await callRead("frappe.client.get_value", { doctype, filters: { name: value }, fieldname: titleField })
			if (current === sequence) englishLabel.value = record?.[titleField] || value
		} catch (cause) { if (current === sequence) error.value = cause.message }
	}, { immediate: true })
	onBeforeUnmount(() => sequence++)
	const label = computed(() => props.modelValue ? displayName(props.doctype, props.modelValue, englishLabel.value) : englishLabel.value)
	return { label, error }
}
