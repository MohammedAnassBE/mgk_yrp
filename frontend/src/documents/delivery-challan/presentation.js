export function summary(doc, itemCount = doc.items?.length || 0) {
	return { title: "Dispatch summary", lines: [
		{ label: "To", value: doc.to_location }, { label: "From", value: doc.from_location },
		{ label: "Process", value: doc.process_name }, { label: "Items", value: itemCount },
		{ label: "Dispatched quantity", value: doc.total_qty || 0 },
		{ label: "Declared value", value: doc.total_declared_value || 0, money: true },
	], checklist: [
		{ label: "Check the job worker and date", complete: Boolean(doc.to_location && doc.posting_date) },
		{ label: "Check locations, warehouses and process", complete: Boolean(doc.from_location && doc.from_warehouse && doc.to_warehouse && doc.process_name) },
		{ label: "Enter dispatched quantities", complete: itemCount > 0 && Number(doc.total_qty) > 0 },
	] }
}

export function viewFacts(doc) {
	return [["From Location", doc.from_location], ["From Warehouse", doc.from_warehouse],
		["To Location", doc.to_location], ["To Warehouse", doc.to_warehouse], ["Process", doc.process_name],
		["Posting Date", doc.posting_date], ["DC Number", doc.dc_number], ["Vehicle Number", doc.vehicle_number],
		...(doc.is_return ? [["Return Against", doc.return_against]] : [])].map(([label, value]) => ({ label, value }))
}
