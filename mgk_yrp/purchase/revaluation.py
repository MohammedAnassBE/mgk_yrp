import frappe
from frappe import _
from frappe.utils import flt
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_adjustment,
	find_receipt_sle,
	is_stock_adjustment_enabled,
)
from yrp.yrp_stock.doctype.yrp_stock_valuation_closing.yrp_stock_valuation_closing import (
	lock_stock_valuation_period,
)

from mgk_yrp.stock.dependencies import CLOSE, StockDependencies


def lock_invoice_sources(invoice, grns):
	receipts = (
		frappe.db.sql(
			"""SELECT name FROM `tabYRP Stock Ledger Entry`
		WHERE voucher_type = 'MGK Goods Received Note' AND voucher_no IN %(grns)s
			AND qty > 0 AND is_cancelled = 0 ORDER BY name""",
			{"grns": tuple(sorted(set(grns)))},
			pluck=True,
		)
		if grns
		else []
	)
	graph = StockDependencies(
		receipts,
		documents={"MGK Goods Received Note": grns, invoice.doctype: [invoice.name]},
	).lock()
	if invoice.docstatus in (1, 2):
		validate_reopening_closes(graph)


def validate_reopening_closes(graph):
	for name in sorted(graph.close_names):
		status = frappe.db.get_value(CLOSE, name, "reopen_status", for_update=True)
		if status == "Reversing":
			frappe.throw(
				_("Finish reopening Close {0} before submitting or cancelling a Purchase Invoice.").format(
					name
				)
			)


def build_invoice_allocations(invoice) -> list[dict]:
	allocations = []
	for row in invoice.items:
		target = find_receipt_sle(
			"MGK Goods Received Note", row.goods_received_note, row.goods_received_note_item
		)
		if not target:
			frappe.throw(
				_("Missing receipt ledger entry for GRN {0}, row {1}.").format(
					row.goods_received_note, row.goods_received_note_item
				)
			)
		allocations.append(
			{
				"target_sle": target,
				"item": row.item,
				"quantity": row.stock_qty,
				"old_rate": flt(row.grn_rate) / flt(row.conversion_factor),
				"new_rate": flt(row.rate) / flt(row.conversion_factor),
				"difference": flt(flt(row.qty) * (flt(row.rate) - flt(row.grn_rate)), 6),
				"allocation_weight": row.stock_qty,
				"source_row": row.name,
				"stock_dimensions": "{}",
			}
		)
	return allocations


def require_stock_adjustment() -> None:
	if not is_stock_adjustment_enabled():
		frappe.throw(_("Enable Apply Stock Adjustment in YRP Settings to submit a Purchase Invoice."))


def create_invoice_adjustment(invoice) -> str | None:
	require_stock_adjustment()
	allocations = build_invoice_allocations(invoice)
	has_difference = any(row["difference"] for row in allocations)
	# Check every target: yrp discards zero rows before checking a mixed revision.
	if has_difference and any(not row["difference"] for row in allocations):
		lock_stock_valuation_period(shared=True)
		create_adjustment(
			adjustment_type="Purchase Invoice Rate Difference",
			source_doctype=invoice.doctype,
			source_name=invoice.name,
			effective_date=invoice.posting_date,
			allocations=[{**row, "difference": 0} for row in allocations],
		)
	return create_adjustment(
		adjustment_type="Purchase Invoice Rate Difference",
		source_doctype=invoice.doctype,
		source_name=invoice.name,
		effective_date=invoice.posting_date,
		allocations=allocations,
	)
