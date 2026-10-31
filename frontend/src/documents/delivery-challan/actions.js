import { completeTransferActions, pendingTransferRows } from "../shared/transit.js"

const method = "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan"

function returnActions(can) {
	return can("MGK Delivery Challan", "create") ? [{ key: "return", label: "Return",
		method: `${method}.make_return_delivery_challan`, route: "/delivery-challan" }] : []
}

function jobWorkActions(can) {
	const result = returnActions(can)
	if (can("MGK Delivery Challan Close", "create")) result.push({ key: "close", label: "Close",
		dialog: () => import("./CloseDcDialog.vue") })
	if (can("MGK Goods Received Note", "create")) result.push({ key: "create-grn", label: "Create GRN",
		method: "mgk_yrp.job_work.grn_from_dc.make_job_work_grn", route: "/goods-received-note" })
	if (can("MGK Process Planning", "write")) result.push({ key: "update-plan", label: "Update Plan",
		dialog: () => import("./UpdatePlanDialog.vue") })
	return result
}

function submittedActions(doc, can) {
	if (Number(doc.docstatus) !== 1 || doc.is_return) return []
	if (doc.is_internal_transfer) return pendingTransferRows(doc).length ? returnActions(can) : []
	return doc.close_status === "Open" ? jobWorkActions(can) : []
}

export function actions(doc, can) {
	const result = [...completeTransferActions(doc, can), ...submittedActions(doc, can)]
	if (doc.delivery_challan_close && can("MGK Delivery Challan Close", "read")) result.push({
		key: "view-close", label: "View Close", to: `/delivery-challan-close/${encodeURIComponent(doc.delivery_challan_close)}`,
	})
	return result
}
