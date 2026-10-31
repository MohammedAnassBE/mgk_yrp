import { getDocument, invalidateReads } from "../api/client.js"
import { reopenConfirmation } from "../documents/delivery-challan-close/actions.js"

export function lifecycleActions(doc, meta, can) {
	const actions = []
	if (Number(doc.docstatus) === 0 && Number(meta.is_submittable) && can(doc.doctype, "submit")) {
		actions.push({ key: "submit", label: "Submit", confirm: `Confirm submit for ${doc.name}?`, run: submit })
	}
	if (Number(doc.docstatus) === 1 && can(doc.doctype, "cancel")) {
		const is_close = doc.doctype === "MGK Delivery Challan Close"
		actions.push({ key: "cancel", label: is_close ? "Reopen" : "Cancel",
			confirm: is_close ? reopenConfirmation(doc) : `Confirm cancel for ${doc.name}?`, run: cancel })
	}
	return actions
}

async function submit({ doc }, { call, isCurrent }) {
	invalidateReads()
	const latest = await getDocument(doc.doctype, doc.name)
	if (isCurrent && !isCurrent()) return
	const saved = await call("frappe.client.submit", { doc: latest })
	return { doc: saved, message: `${doc.name} submitted.` }
}

async function cancel({ doc }, { call }) {
	const saved = await call("frappe.client.cancel", { doctype: doc.doctype, name: doc.name })
	const message = doc.doctype === "MGK Delivery Challan Close"
		? `${doc.delivery_challan} reopening started.` : `${doc.name} cancelled.`
	return { doc: saved, message }
}
