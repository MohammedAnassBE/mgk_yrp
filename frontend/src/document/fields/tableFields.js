import { visibleFields } from "../fieldConditions.js"
import closeLayout from "../../documents/delivery-challan-close/documentLayout.js"

const closeResultFields = {
	items: ["consumed_value", "value_gap"],
	outputs: ["allocated_value", "allocated_rate"],
}

export function tableFields(meta, field, parent, permissionMeta, row, user) {
	const hidden = parent?.doctype === "MGK Delivery Challan Close" && Number(parent.docstatus) === 0
		? closeResultFields[field.fieldname] || [] : []
	const columns = field.columns ? field.columns.map((name) => meta?.fields.find((column) => column.fieldname === name)).filter(Boolean)
		: parent?.doctype === "MGK Delivery Challan Close" && field.fieldname === "outputs" ? closeLayout.outputColumns.map((name) => meta?.fields.find((field) => field.fieldname === name)).filter(Boolean) : meta?.fields || []
	const fields = columns.filter((field) => !["Table", "Table MultiSelect"].includes(field.fieldtype)
		&& !(field.fieldtype === "Data" && /(?:_item|_row)$/.test(field.fieldname)) && !hidden.includes(field.fieldname))
	return visibleFields(fields, { ...row, docstatus: parent?.docstatus ?? row?.docstatus }, permissionMeta, user, parent)
		.map((field) => parent?.doctype === "MGK Delivery Challan Close" && Number(parent.docstatus) !== 0 && field.fieldname === "allocated_rate"
			? { ...field, label: "Allocated Rate at Close" } : field)
}
