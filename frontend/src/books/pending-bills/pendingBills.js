import { flt, groupItemRows, invoiceTotals, rateChanged, setGroupRate } from "../../documents/purchase-invoice/fieldEvents.js"

export const method = "mgk_yrp.web.pending_bills"
export const bucketClass = { "30+": "aging-old", "16-30": "aging-late", "8-15": "aging-due", "0-7": "aging-new" }
export const bucketLabel = (bucket) => bucket.replace("-", "–")
export const typeLabel = (against) => against === "Purchase Order" ? "PO" : "Job Work"

export function itemTooltip(grn) {
	return (grn.items || []).map((row) => `${row.item_name || row.item} · ${row.qty} × ${flt(row.rate, 2)} = ${flt(row.amount, 2)}`).join("\n")
}

/** Selected GRN names grouped by supplier, in page order. */
export function selectedBySupplier(suppliers, selected) {
	return suppliers.map((group) => ({ supplier: group.supplier, supplier_name: group.supplier_name,
		grns: group.grns.filter((grn) => selected.has(grn.name)).map((grn) => grn.name) })).filter((group) => group.grns.length)
}

export function toggleAll(selected, names, checked) {
	const next = new Set(selected)
	for (const name of names) checked ? next.add(name) : next.delete(name)
	return next
}

export const allChecked = (selected, names) => names.length > 0 && names.every((name) => selected.has(name))

/** Drop selections whose GRN has left the pending list. */
export function keepPending(selected, suppliers) {
	const pending = new Set(suppliers.flatMap((group) => group.grns.map((grn) => grn.name)))
	return new Set([...selected].filter((name) => pending.has(name)))
}

/** One popup block per supplier, holding its drafts (one per Against type). */
export function buildBlocks(groups, drafts, today) {
	return groups.map((group) => ({ ...group, bill_no: "", bill_date: today, error: "",
		drafts: drafts.filter((draft) => draft.supplier === group.supplier).map((draft) => ({ ...draft, items: draft.items.map((row) => ({ ...row })) })) }))
}

export function setDraftRate(draft, indices, rate) {
	const items = setGroupRate(draft.items, indices, rate).map((row) => rateChanged({ ...row }, draft.tax_type))
	return { ...draft, items, ...invoiceTotals(items) }
}

export const draftGroups = (draft) => groupItemRows(draft.items)

export function blockTotals(block) {
	const totals = block.drafts.map((draft) => invoiceTotals(draft.items))
	const sum = (field) => flt(totals.reduce((total, row) => total + row[field], 0), 2)
	return { net_total: sum("net_total"), total_tax: sum("total_tax"), grand_total: sum("grand_total") }
}

/** Client-side required checks; returns the block list with errors set. */
export function validateBlocks(blocks) {
	return blocks.map((block) => ({ ...block, error: !String(block.bill_no || "").trim() ? "Supplier Invoice No is required."
		: !block.bill_date ? "Supplier Invoice Date is required." : "" }))
}

export function billPayload(blocks) {
	return blocks.map((block) => ({
		supplier: block.supplier, bill_no: String(block.bill_no).trim(), bill_date: block.bill_date,
		grns: block.grns,
		rates: Object.fromEntries(block.drafts.flatMap((draft) => draft.items.map((row) => [row.goods_received_note_item, flt(row.rate)]))),
	}))
}

/** The supplier a create_bills failure belongs to, from the thrown message title. */
export function failedSupplier(error) {
	let messages = error?.payload?._server_messages || []
	try { messages = typeof messages === "string" ? JSON.parse(messages) : messages } catch { return "" }
	for (const entry of messages) {
		try {
			const message = typeof entry === "string" ? JSON.parse(entry) : entry
			if (message?.title) return message.title
		} catch { continue }
	}
	return ""
}
