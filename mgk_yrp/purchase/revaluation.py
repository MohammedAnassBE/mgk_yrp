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


def create_invoice_adjustment(invoice) -> str | None:
	allocations = build_invoice_allocations(invoice)
	has_difference = any(row["difference"] for row in allocations)
	if has_difference and not is_stock_adjustment_enabled():
		frappe.throw(_("Enable Apply Stock Adjustment in YRP Settings to submit a rate change."))
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
