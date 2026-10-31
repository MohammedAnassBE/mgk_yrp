import { stageMappedDraft } from "../../document/mappedDraft.js"
import { hasPermission, hasPermissions } from "../../permissions/usePermissions.js"
export const jobWorkMethods = {
	createGrn: "mgk_yrp.job_work.grn_from_dc.make_job_work_grn",
	getPlan: "mgk_yrp.job_work.process_plan.get_process_plan",
	savePlan: "mgk_yrp.job_work.process_plan.save_process_plan",
	createDc: "mgk_yrp.job_work.dc_from_grn.make_delivery_challan_from_grns",
	previewClose: "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan.make_delivery_challan_close",
	closeDc: "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan.close_delivery_challan",
}

export function dispatchSelection({ doc, names, rows = [] }) {
	const warehouses = doc ? [doc.warehouse] : rows.map((row) => row.warehouse)
	const is_forced = new Set(warehouses).size > 1
	return { source_names: doc ? [doc.name] : [...names], is_forced, move_to_head_office: is_forced }
}

export async function createGrnFromSelection({ names }, { call, navigate }) {
	const receipt = await call(jobWorkMethods.createGrn, { source_names: names })
	const draft = stageMappedDraft(receipt)
	await navigate({ path: "/goods-received-note/new", query: { draft } })
}

export async function saveProcessPlan(delivery_challan, items, call) {
	await call(jobWorkMethods.savePlan, { delivery_challan, item_details: JSON.stringify(items) })
	return { message: "Process plan updated." }
}

export function canMoveToHeadOffice(can = hasPermission) {
	return hasPermissions("YRP Stock Entry", ["create", "submit"], can)
}

export async function createDcFromSelection(selection, values, call, can = hasPermission) {
	if ((selection.is_forced || values.move_to_head_office) && !canMoveToHeadOffice(can)) {
		throw new Error("Moving stock to Head Office needs create and submit permission on YRP Stock Entry.")
	}
	const result = await call(jobWorkMethods.createDc, {
		source_names: selection.source_names, process_name: values.process_name, supplier: values.supplier,
		move_to_head_office: Number(selection.is_forced || values.move_to_head_office),
	})
	const entries = result.stock_entries || []
	return {
		message: entries.length ? `Dispatch submitted (Stock Entries: ${entries.join(", ")}):` : "Dispatch submitted:",
		links: [{ label: result.delivery_challan, to: `/delivery-challan/${encodeURIComponent(result.delivery_challan)}` }],
	}
}

export async function closeDeliveryChallan(source_name, call) {
	const close = await call(jobWorkMethods.closeDc, { source_name })
	return { message: `Delivery Challan ${source_name} closed:`,
		links: [{ label: close, to: `/delivery-challan-close/${encodeURIComponent(close)}` }] }
}
