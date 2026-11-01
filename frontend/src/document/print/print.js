export const printAction = { key: "print", label: "Print", dialog: () => import("./PrintDialog.vue") }

export function canPrint(doc, isNew, can) {
	return Boolean(doc?.name && !isNew && can(doc.doctype, "print"))
}

export function buildPrintUrl({ doctype, name, format, letterHead }) {
	const query = new URLSearchParams({ doctype, name, format, no_letterhead: letterHead ? "0" : "1", trigger_print: "1" })
	if (letterHead) query.set("letterhead", letterHead)
	return `/printview?${query}`
}

export function buildPrintPdfArgs({ doctype, name, format, letterHead }) {
	return { doctype, name, format, no_letterhead: letterHead ? 0 : 1, ...(letterHead ? { letterhead: letterHead } : {}) }
}

export function openPrintUrl(url) {
	return Boolean(globalThis.window?.open(url, "_blank"))
}
