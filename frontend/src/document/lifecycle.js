export function canAmendDocument(doc, allowed) {
	return Number(doc.docstatus) === 2 && allowed("amend") && !doc.__onload?.valuation_pending
		&& !["Reversing", "Reopening"].includes(doc.reopen_status)
}
