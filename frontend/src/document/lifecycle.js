export function canAmendDocument(doc, allowed) {
	return Number(doc.docstatus) === 2 && allowed("amend") && !doc.__onload?.valuation_pending
		&& !["Reversing", "Reopening"].includes(doc.reopen_status)
}

export const isSaveShortcut = (event) => (event.ctrlKey || event.metaKey) && event.key?.toLowerCase() === "s"
export const hasOpenDialog = () => Boolean(globalThis.document?.querySelector?.('dialog[open], [role="dialog"], .p-dialog-mask'))
