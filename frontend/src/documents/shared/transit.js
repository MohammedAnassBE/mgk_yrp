export function pendingTransferQuantity(row) {
	return Number(row.qty || 0) - Number(row.transferred_qty || 0)
		- Number(row.returned_qty || 0) / (Number(row.conversion_factor) || 1)
}

export function pendingTransferRows(doc) {
	return (doc.items || []).filter((row) => pendingTransferQuantity(row) > 0.000001)
}

export function completeTransferActions(doc, can) {
	return Number(doc.docstatus) === 1 && doc.is_internal_transfer && pendingTransferRows(doc).length
		&& can("YRP Stock Entry", "create")
		? [{ key: "complete-transfer", label: "Complete Transfer", forward: true,
			dialog: () => import("./CompleteTransferDialog.vue") }] : []
}

export function transferIntro(doc) {
	if (Number(doc.docstatus) !== 1 || !doc.is_internal_transfer) return null
	const quantities = pendingTransferRows(doc).map((row) =>
		`${row.item} ${Number(pendingTransferQuantity(row).toFixed(6))} ${row.uom || ""}`.trim())
	return quantities.length ? { text: `Pending in transit: ${quantities.join(", ")}`, severity: "warn" } : null
}

export function transferDestination(doc) {
	const is_challan = doc.doctype === "MGK Delivery Challan"
	return { warehouse: (is_challan ? doc.to_warehouse : doc.warehouse) || "",
		filters: { supplier: is_challan ? doc.to_location : doc.delivery_location,
			disabled: 0, is_group: 0, name: ["!=", doc.transit_warehouse] } }
}

function rowAttributes(doc) {
	const data = doc.__onload?.item_details || doc.item_details || []
	const groups = typeof data === "string" ? JSON.parse(data) : data
	const attributes = new Map()
	for (const group of groups) for (const entry of group.items || []) {
		for (const [variant, cell] of Object.entries(entry.values || {})) {
			if (!cell?.name) continue
			attributes.set(cell.name, { ...entry.attributes,
				...(group.primary_attribute ? { [group.primary_attribute]: variant } : {}) })
		}
	}
	return attributes
}

export function transferItems(doc, pendingOnly = false) {
	const attributes = rowAttributes(doc)
	const rows = pendingOnly ? pendingTransferRows(doc) : doc.items || []
	return rows.map((row) => ({ source_row: row.name, item: row.item, uom: row.uom,
		attributes: attributes.get(row.name) || {}, original_qty: Number(row.qty || 0),
		transferred_qty: Number(row.transferred_qty || 0), pending_qty: pendingTransferQuantity(row),
		qty: pendingTransferQuantity(row) }))
}

export function transferArguments(doc, warehouse, rows) {
	if (!warehouse) throw new Error("Receiving Warehouse is required.")
	const items = rows.filter((row) => Number(row.qty) !== 0)
	if (!items.length) throw new Error("Enter a positive quantity to complete the transfer.")
	if (items.some((row) => !Number.isFinite(Number(row.qty)) || Number(row.qty) < 0 || Number(row.qty) > row.pending_qty)) {
		throw new Error("Quantity must be positive and cannot exceed pending quantity.")
	}
	return { doctype: doc.doctype, name: doc.name, warehouse,
		items: items.map((row) => ({ name: row.source_row, qty: Number(row.qty) })) }
}

export async function completeTransfer(doc, warehouse, rows, call) {
	const name = await call("mgk_yrp.stock.transit.complete_transfer", transferArguments(doc, warehouse, rows))
	return { message: name ? "Stock Entry submitted:" : "Transfer completed.",
		links: name ? [{ label: name, to: `/app/yrp-stock-entry/${encodeURIComponent(name)}` }] : [] }
}
