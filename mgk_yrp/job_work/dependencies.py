import frappe
from frappe import _

from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import get_linking_grns
from mgk_yrp.stock.dependencies import StockDependencies, get_grn_receipts, validate_reopening_closes


def lock_close_submission(close, previous=None):
	names = sorted(set(filter(None, [previous, close.delivery_challan])))
	grns = {name for challan in names for name in get_linking_grns(challan, (0, 1))}
	challans = [frappe.get_doc("MGK Delivery Challan", name) for name in names]
	graph = StockDependencies(
		get_grn_receipts(grns),
		buckets=((row.item, challan.to_warehouse) for challan in challans for row in challan.items),
		documents={
			"MGK Delivery Challan": names,
			"MGK Goods Received Note": grns,
			close.doctype: [] if close.is_new() else [close.name],
		},
	).lock()
	if set(get_grn_receipts(grns, for_update=True)) != graph.receipts:
		frappe.throw(_("Stock dependencies changed; retry the operation."))
	if close.docstatus == 1:
		validate_reopening_closes(graph, _("submitting a Delivery Challan Close"))
	return graph


def lock_close_dependencies(close):
	return StockDependencies(
		(row.output_receipt_sle for row in close.outputs),
		entries=(row.consumption_sle for row in close.items),
		buckets=((row.item, close.warehouse) for row in close.items),
		documents={close.doctype: [close.name], "MGK Delivery Challan": [close.delivery_challan]},
	).lock()


def get_independent_consumptions(close):
	receipts = tuple(sorted({row.output_receipt_sle for row in close.outputs if row.output_receipt_sle}))
	if not receipts:
		return []
	return frappe.db.sql(
		"""SELECT DISTINCT consumption_sle FROM `tabYRP Stock Valuation Production Link`
		WHERE active = 1 AND source_doctype = %(doctype)s AND source_name != %(name)s
			AND output_receipt_sle IN %(receipts)s ORDER BY consumption_sle FOR UPDATE""",
		{"doctype": close.doctype, "name": close.name, "receipts": receipts},
		pluck=True,
	)


def get_downstream_blockers(close, *, graph=None, close_blockers=None) -> list[str]:
	"""Follow the same receipt, outgoing, transfer and production paths as YRP."""
	if not close.outputs:
		return []
	graph = graph or lock_close_dependencies(close)
	closes = get_close_blockers(close, graph.outgoing.values()) if close_blockers is None else close_blockers
	blockers = list(closes.values())
	nodes = graph.nodes - graph.entries
	if nodes:
		blockers.extend(
			get_adjustment_blockers(
				close,
				tuple(sorted(nodes)),
				completed=False,
				excluded_sources=closes,
			)
		)
	return list(dict.fromkeys(blockers))


def get_close_blockers(close, outgoing) -> dict[str, str]:
	names = sorted(
		{
			row.voucher_no
			for row in outgoing
			if row.voucher_type == close.doctype and row.voucher_no != close.name
		}
	)
	blockers = {}
	for name in names:
		downstream = frappe.db.get_value(
			close.doctype,
			name,
			["docstatus", "reopen_status"],
			as_dict=True,
			for_update=True,
		)
		if downstream.docstatus != 2 or downstream.reopen_status != "Reopened":
			blockers[name] = _("Reopen and finish downstream Close {0} before reopening {1}.").format(
				name, close.name
			)
	return blockers


def get_adjustment_blockers(close, nodes, *, completed=True, excluded_sources=()) -> list[str]:
	blockers = []
	completed_clause = (
		"OR (adjustment.status = 'Completed' AND COALESCE(adjustment.reversal_of, '') = '')"
		if completed
		else ""
	)
	for table, relationship in (
		("YRP Stock Valuation Adjustment Source", "node.parent = adjustment.name"),
		("YRP Stock Valuation Propagation Entry", "node.adjustment = adjustment.name"),
	):
		adjustments = frappe.db.sql(
			f"""
			SELECT DISTINCT adjustment.name, adjustment.source_doctype, adjustment.source_name,
				adjustment.status
			FROM `tabYRP Stock Valuation Adjustment` adjustment
			JOIN `tab{table}` node ON {relationship}
			WHERE adjustment.docstatus = 1 AND adjustment.name != %(own)s
				AND (node.source_sle IN %(nodes)s OR node.target_sle IN %(nodes)s)
				AND (adjustment.status NOT IN ('Completed', 'Reversed') {completed_clause})
			ORDER BY adjustment.name FOR UPDATE
			""",
			{"nodes": nodes, "own": close.stock_valuation_adjustment or ""},
			as_dict=True,
		)
		blockers.extend(
			format_adjustment_blocker(row)
			for row in adjustments
			if not (row.source_doctype == close.doctype and row.source_name in excluded_sources)
		)
	return list(dict.fromkeys(blockers))


def format_adjustment_blocker(adjustment) -> str:
	message = _("Stock Valuation Adjustment {0} ({1}) from {2} {3} blocks reopening.").format(
		adjustment.name, adjustment.status, adjustment.source_doctype, adjustment.source_name
	)
	if adjustment.status == "Completed":
		action = (
			_("Reopen its source Close and finish its reversal before reopening.")
			if adjustment.source_doctype == "MGK Delivery Challan Close"
			else _("Cancel its source and finish its reversal before reopening.")
		)
	elif adjustment.status == "Reversal Queued":
		action = _("Wait for its reversal to finish; retry the reversal if it fails.")
	elif adjustment.status in {"Calculation Failed", "Apply Failed"}:
		action = _("Retry the failed valuation before reopening.")
	else:
		action = _("Wait for the valuation to finish before reopening; retry it if it stalls or fails.")
	return f"{message} {action}"
