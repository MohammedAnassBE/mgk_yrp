export const totalFields = ["total_qty", "net_total", "total_cgst", "total_sgst", "total_igst", "total_tax", "grand_total"]
export const previewFields = ["items", "supplier_gstin", "company_gstin", "tax_type", ...totalFields]

export function flt(value, precision, method = globalThis.window?.frappe?.boot?.sysdefaults?.rounding_method || "Banker's Rounding (legacy)") {
	const number = typeof value === "number" ? value : parseFloat(String(value ?? "").replaceAll(",", "")) || 0
	if (precision == null) return number
	const multiplier = 10 ** precision
	const scaled = Math.abs(number) * multiplier
	if (method === "Banker's Rounding (legacy)") return Math.sign(number) * Math.round(Number(scaled.toFixed(8))) / multiplier
	const epsilon = 2 ** (Math.log2(scaled) - 52)
	if (method === "Commercial Rounding") return Math.sign(number) * Math.round(scaled + (epsilon >= 0.25 ? 0 : epsilon)) / multiplier
	if (method !== "Banker's Rounding") throw new Error(`Unknown rounding method ${method}`)
	const floor = Math.floor(scaled)
	const tie = epsilon < 0.5 ? Math.abs(scaled - floor - 0.5) < epsilon : scaled - floor === 0.5
	return Math.sign(number) * (tie ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled)) / multiplier
}

export function invoiceTotals(rows) {
	const sum = (field) => rows.reduce((total, row) => total + flt(row[field]), 0)
	const tax = flt(sum("cgst_amount") + sum("sgst_amount") + sum("igst_amount"), 2)
	return { total_qty: sum("qty"), net_total: flt(sum("amount"), 2),
		total_cgst: flt(sum("cgst_amount"), 2), total_sgst: flt(sum("sgst_amount"), 2),
		total_igst: flt(sum("igst_amount"), 2), total_tax: tax, grand_total: flt(sum("amount") + tax, 2) }
}

export function rateChanged(row, taxType) {
	row.amount = flt(flt(row.qty) * flt(row.rate), 2)
	row.cgst_amount = row.sgst_amount = row.igst_amount = 0
	if (taxType === "CGST + SGST") row.cgst_amount = row.sgst_amount = flt(row.amount * flt(row.gst_rate) / 200, 2)
	else if (taxType === "IGST") row.igst_amount = flt(row.amount * flt(row.gst_rate) / 100, 2)
	return row
}

export function invoiceChanges(name, doc) {
	if (Number(doc.docstatus) !== 0) return {}
	if (["against", "supplier"].includes(name)) return { items: [], supplier_gstin: "", company_gstin: "", tax_type: "No Tax", ...invoiceTotals([]) }
	if (name === "items") {
		for (const row of doc.items || []) rateChanged(row, doc.tax_type)
		return invoiceTotals(doc.items || [])
	}
	return {}
}

export function createFieldEvents({ getDoc }) {
	return { change(name) { Object.assign(getDoc(), invoiceChanges(name, getDoc())) } }
}

export function canGetGrns(doc) { return Number(doc.docstatus) === 0 && Boolean(doc.supplier && doc.against) }

export function groupGrnRows(rows) {
	const groups = new Map()
	for (const [index, row] of rows.entries()) {
		if (!groups.has(row.goods_received_note)) groups.set(row.goods_received_note, [])
		groups.get(row.goods_received_note).push({ row, index })
	}
	return [...groups].map(([name, rows]) => ({ name, rows }))
}

const summedFields = ["qty", "amount", "cgst_amount", "sgst_amount", "igst_amount"]

export function groupItemRows(rows) {
	const groups = new Map()
	for (const [index, row] of rows.entries()) {
		const key = JSON.stringify([row.item, row.uom, flt(row.grn_rate)])
		if (!groups.has(key)) groups.set(key, { key, ...row, ...Object.fromEntries(summedFields.map((field) => [field, 0])), indices: [] })
		const group = groups.get(key)
		for (const field of summedFields) group[field] = flt(group[field] + flt(row[field]), 6)
		group.indices.push(index)
	}
	return [...groups.values()]
}

export function setGroupRate(rows, indices, rate) {
	return rows.map((row, index) => indices.includes(index) ? { ...row, rate: rate ?? 0 } : row)
}

export function grnSummaries(groups, dates = {}) {
	return groups.map(({ name, rows }) => ({ name, posting_date: dates[name] || "",
		total_qty: flt(rows.reduce((total, { row }) => total + flt(row.qty), 0), 6),
		total_amount: flt(rows.reduce((total, { row }) => total + flt(row.qty) * flt(row.grn_rate), 0), 2) }))
}
