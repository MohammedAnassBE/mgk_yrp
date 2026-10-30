import { onBeforeUnmount, ref, watch } from "vue"
import { callRead, getMeta } from "../api/client.js"

export function useLinkLabel(props) {
	const label = ref(props.modelValue || "")
	const error = ref("")
	let sequence = 0
	watch(() => [props.doctype, props.modelValue], async ([doctype, value]) => {
		const current = ++sequence
		label.value = value || ""
		error.value = ""
		if (!doctype || !value) return
		try {
			const meta = (await getMeta(doctype)).find((entry) => entry.name === doctype)
			if (current !== sequence || Number(meta?.show_title_field_in_link) !== 1 || !meta.title_field) return
			const record = await callRead("frappe.client.get_value", { doctype, filters: { name: value }, fieldname: meta.title_field })
			if (current === sequence) label.value = record?.[meta.title_field] || value
		} catch (cause) { if (current === sequence) error.value = cause.message }
	}, { immediate: true })
	onBeforeUnmount(() => sequence++)
	return { label, error }
}
