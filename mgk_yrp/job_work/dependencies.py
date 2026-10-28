import frappe
from frappe import _


def get_downstream_blockers(close) -> list[str]:
	"""Follow the same receipt, outgoing, transfer and production paths as YRP."""
	pending = {row.output_receipt_sle for row in close.outputs if row.output_receipt_sle}
	visited, blockers = set(), []
	while pending:
		receipts = tuple(sorted(pending - visited))
		if not receipts:
			break
		visited.update(receipts)
		outgoing = get_outgoing_entries(receipts)
		blockers.extend(get_close_blockers(close, outgoing))
		nodes = tuple(sorted(set(receipts) | {row.name for row in outgoing}))
		blockers.extend(get_adjustment_blockers(close, nodes))
		pending = get_next_receipts(outgoing)
	return list(dict.fromkeys(blockers))


def get_outgoing_entries(receipts):
	return frappe.db.sql(
		"""
		SELECT DISTINCT outgoing.name, outgoing.voucher_type, outgoing.voucher_no,
			outgoing.paired_stock_ledger_entry
		FROM `tabYRP Stock Ledger Entry` receipt
		JOIN `tabYRP Stock Ledger Entry` outgoing
			ON outgoing.item = receipt.item AND outgoing.warehouse = receipt.warehouse
			AND outgoing.posting_datetime >= receipt.posting_datetime
		WHERE receipt.name IN %(receipts)s AND receipt.is_cancelled = 0
			AND outgoing.is_cancelled = 0 AND outgoing.qty < 0
		ORDER BY outgoing.name FOR UPDATE
		""",
		{"receipts": receipts},
		as_dict=True,
	)


def get_next_receipts(outgoing) -> set[str]:
	pending = {row.paired_stock_ledger_entry for row in outgoing if row.paired_stock_ledger_entry}
	if outgoing:
		pending.update(
			frappe.db.sql(
				"""SELECT output_receipt_sle FROM `tabYRP Stock Valuation Production Link`
				WHERE consumption_sle IN %(outgoing)s AND active = 1
				ORDER BY name FOR UPDATE""",
				{"outgoing": tuple(row.name for row in outgoing)},
				pluck=True,
			)
		)
	return pending


def get_close_blockers(close, outgoing) -> list[str]:
	names = sorted(
		{
			row.voucher_no
			for row in outgoing
			if row.voucher_type == close.doctype and row.voucher_no != close.name
		}
	)
	blockers = []
	for name in names:
		downstream = frappe.db.get_value(
			close.doctype,
			name,
			["docstatus", "reopen_status"],
			as_dict=True,
			for_update=True,
		)
		if downstream.docstatus != 2 or downstream.reopen_status != "Reopened":
			blockers.append(
				_("Reopen and finish downstream Close {0} before reopening {1}.").format(name, close.name)
			)
	return blockers


def get_adjustment_blockers(close, nodes) -> list[str]:
	blockers = []
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
				AND (adjustment.status NOT IN ('Completed', 'Reversed') OR
					(adjustment.status = 'Completed' AND COALESCE(adjustment.reversal_of, '') = ''))
			ORDER BY adjustment.name FOR UPDATE
			""",
			{"nodes": nodes, "own": close.stock_valuation_adjustment or ""},
			as_dict=True,
		)
		blockers.extend(format_adjustment_blocker(row) for row in adjustments)
	return list(dict.fromkeys(blockers))


def format_adjustment_blocker(adjustment) -> str:
	return _(
		"Stock Valuation Adjustment {0} ({1}) from {2} {3} blocks reopening; "
		"cancel its source and finish its reversal, or retry the unfinished valuation first."
	).format(adjustment.name, adjustment.status, adjustment.source_doctype, adjustment.source_name)
