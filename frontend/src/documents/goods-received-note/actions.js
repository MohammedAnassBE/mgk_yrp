import { completeTransferActions } from "../shared/transit.js"

export function actions(doc, can) {
	const result = completeTransferActions(doc, can)
	if (Number(doc.docstatus) === 1 && !doc.is_internal_transfer && can("MGK Delivery Challan", "create")) result.push({
		key: "create-dc", label: "Create DC", forward: true, dialog: () => import("./CreateDcDialog.vue"),
	})
	return result
}
