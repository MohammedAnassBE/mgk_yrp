import { onBeforeUnmount, ref, watch } from "vue"
import { callRead, getMeta } from "../api/client.js"
import { language, isTamilDisplay, TAMIL_NAME_FIELD } from "../shell/displayLanguage.js"

export function useLinkLabel(props) {
	const label = ref(props.modelValue || "")
	const error = ref("")
	let sequence = 0
	watch(() => [props.doctype, props.modelValue, language.value], async ([doctype, value]) => {
		const current = ++sequence
		label.value = value || ""
		error.value = ""
		if (!doctype || !value) return
		try {
			const meta = (await getMeta(doctype)).find((entry) => entry.name === doctype)
			const titleField = Number(meta?.show_title_field_in_link) === 1 && meta.title_field ? meta.title_field : ""
			const fields = [titleField, isTamilDisplay(doctype) ? TAMIL_NAME_FIELD : ""].filter(Boolean)
			if (current !== sequence || !fields.length) return
			const record = await callRead("frappe.client.get_value", { doctype, filters: { name: value }, fieldname: fields.length > 1 ? fields : fields[0] })
			if (current === sequence) label.value = record?.[TAMIL_NAME_FIELD] || record?.[titleField] || value
		} catch (cause) { if (current === sequence) error.value = cause.message }
	}, { immediate: true })
	onBeforeUnmount(() => sequence++)
	return { label, error }
}
