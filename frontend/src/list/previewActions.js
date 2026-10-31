import { documentModule } from "../documents/registry.js"
import { lifecycleActions } from "../document/lifecycleActions.js"

export function previewActions(doc, preview, can) {
	const lifecycle = lifecycleActions(doc, preview, can)
	const actions = documentModule(doc.doctype).actions?.(doc, can) || []
	return [...lifecycle.filter((action) => action.key === "submit"),
		...actions.filter((action) => !action.to), ...lifecycle.filter((action) => action.key === "cancel")]
}
