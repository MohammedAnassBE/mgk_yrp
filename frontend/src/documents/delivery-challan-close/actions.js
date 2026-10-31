export function reopenConfirmation(doc) {
	return `Reopen Delivery Challan ${doc.delivery_challan}? Its valuation will be reversed before stock is released.`
}

export function actions(doc, can) {
	return Number(doc.docstatus) === 2 && doc.reopen_status === "Reversing" && can(doc.doctype, "cancel")
		? [{ key: "finish-reopen", label: "Finish Reopen", run: finishReopen }] : []
}

async function finishReopen({ doc }, { call }) {
	const finished = await call("mgk_yrp.job_work.reopen.finish_reopen", { close_name: doc.name })
	return finished ? undefined : { message: "The reversal is still processing." }
}
