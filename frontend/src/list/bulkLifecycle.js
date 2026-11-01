import { getDocument, invalidateReads } from "../api/client.js"

const documents = (count) => `${count} document${count === 1 ? "" : "s"}`

/** Standard Submit, Cancel and Delete actions for selected list rows, filtered by the user's permissions. */
export function lifecycleBulkActions(doctype, meta, can) {
	const submittable = Boolean(Number(meta?.is_submittable))
	const isClose = doctype === "MGK Delivery Challan Close"
	const actions = []
	if (submittable && can(doctype, "submit")) actions.push(bulkAction({
		key: "bulk-submit", label: "Submit", verb: "submitted", effect: "All normal validations will run.",
		eligible: (rows) => rows.filter((row) => Number(row.docstatus) === 0),
		apply: async (row, call) => {
			invalidateReads()
			await call("frappe.client.submit", { doc: await getDocument(doctype, row.name) })
		},
	}))
	if (submittable && can(doctype, "cancel")) actions.push(bulkAction({
		key: "bulk-cancel", label: isClose ? "Reopen" : "Cancel", verb: isClose ? "reopening started" : "cancelled",
		effect: "This reverses their submitted effects.",
		eligible: (rows) => rows.filter((row) => Number(row.docstatus) === 1),
		apply: (row, call) => call("frappe.client.cancel", { doctype, name: row.name }),
	}))
	if (can(doctype, "delete")) actions.push(bulkAction({
		key: "bulk-delete", label: "Delete", verb: "deleted", effect: "This cannot be undone.", danger: true,
		eligible: (rows) => submittable ? rows.filter((row) => Number(row.docstatus) !== 1) : rows,
		apply: (row, call) => call("frappe.client.delete", { doctype, name: row.name }),
	}))
	return actions
}

function bulkAction({ key, label, verb, effect, danger = false, eligible, apply }) {
	return {
		key, label, danger, eligible,
		confirm: (_doc, target) => `${label} ${documents(eligible(target.rows).length)}? ${effect}`,
		run: (target, { call }) => applyEach(eligible(target.rows), (row) => apply(row, call), verb),
	}
}

/** Runs `apply` one row at a time so each failure is reported against its document. */
export async function applyEach(rows, apply, verb) {
	const failures = []
	let completed = 0
	for (const row of rows) {
		try {
			await apply(row)
			completed += 1
		} catch (cause) { failures.push(`${row.name}: ${cause.message}`) }
	}
	return { message: completed ? `${documents(completed)} ${verb}.` : "", failures }
}
