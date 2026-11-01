import { documentModule } from "../documents/registry.js"
import { lifecycleActions } from "../document/lifecycleActions.js"
import { canPrint, printAction } from "../document/print/print.js"

export function previewActions(doc, preview, can) {
	const lifecycle = lifecycleActions(doc, preview, can)
	const actions = documentModule(doc.doctype).actions?.(doc, can) || []
	return [...lifecycle.filter((action) => action.key === "submit"),
		...actions.filter((action) => !action.to), ...(canPrint(doc, false, can) ? [printAction] : []),
		...lifecycle.filter((action) => action.key === "cancel")]
}
