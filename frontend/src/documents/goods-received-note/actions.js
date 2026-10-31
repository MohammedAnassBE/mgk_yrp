import { completeTransferActions } from "../shared/transit.js"
import { hasPermissions } from "../../permissions/usePermissions.js"

export function actions(doc, can) {
	const result = completeTransferActions(doc, can)
	if (Number(doc.docstatus) === 1 && !doc.is_internal_transfer && hasPermissions("MGK Delivery Challan", ["create", "submit"], can)) result.push({
		key: "create-dc", label: "Create DC", dialog: () => import("./CreateDcDialog.vue"),
	})
	return result
}
