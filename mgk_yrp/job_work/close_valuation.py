import frappe
from frappe import _
from frappe.utils import flt
from yrp.stock.stock_ledger import lock_valuation_bucket
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	find_receipt_sle,
)
from yrp.yrp_stock.doctype.yrp_stock_valuation_closing.yrp_stock_valuation_closing import (
	lock_stock_valuation_period,
)

from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import get_linking_grns


def get_active_receipt(voucher_type, voucher_no, row_name):
	name = find_receipt_sle(voucher_type, voucher_no, row_name)
	if not name:
		frappe.throw(_("Missing receipt ledger entry for {0}, row {1}.").format(voucher_no, row_name))
	receipt = frappe.get_doc("YRP Stock Ledger Entry", name, for_update=True)
	if receipt.is_cancelled:
		frappe.throw(_("Receipt ledger entry {0} is cancelled.").format(name))
	if receipt.valuation_is_stale:
		frappe.throw(_("Previous Valuation Update Is Not Complete: receipt {0} is stale.").format(name))
	return receipt


def get_dc_item_values(dc) -> list[frappe._dict]:
	returned = dc.get_returned_stock_qty()
	values = []
	for row in dc.items:
		receipt = get_active_receipt(dc.doctype, dc.name, row.name)
		remaining = flt(receipt.qty - returned[row.name], 6)
		if remaining < 0:
			frappe.throw(_("Returned quantity exceeds the DC receipt quantity."))
		delivered_value = flt(receipt.qty * receipt.rate + receipt.valuation_adjustment_value, 6)
		values.append(
			frappe._dict(
				delivery_challan_item=row.name,
				item=row.item,
				stock_uom=row.stock_uom,
				delivered_stock_qty=receipt.qty,
				returned_stock_qty=returned[row.name],
				remaining_stock_qty=remaining,
				delivered_value=delivered_value,
				own_value=flt(delivered_value * remaining / receipt.qty, 6),
				in_sle=receipt.name,
			)
		)
	return values


def get_linked_outputs(delivery_challan: str) -> list[frappe._dict]:
	outputs = []
	for name in get_linking_grns(delivery_challan, (1,), for_update=True):
		receipt = frappe.get_doc("MGK Goods Received Note", name, for_update=True)
		receipt.check_permission("read")
		for row in receipt.items:
			if row.stock_qty <= 0:
				continue
			ledger = get_active_receipt(receipt.doctype, receipt.name, row.name)
			outputs.append(
				frappe._dict(
					goods_received_note=name,
					goods_received_note_item=row.name,
					item=row.item,
					warehouse=receipt.warehouse,
					stock_uom=row.stock_uom,
					stock_qty=row.stock_qty,
					stock_rate=ledger.rate,
					output_receipt_sle=ledger.name,
				)
			)
	return outputs


def validate_outputs(dc, outputs) -> None:
	units = sorted({row.stock_uom for row in outputs})
	if len(units) > 1:
		frappe.throw(
			_("Linked GRN rows use different stock UOMs ({0}); cannot close.").format(", ".join(units))
		)
	inputs = {(row.item, warehouse) for row in dc.items for warehouse in (dc.from_warehouse, dc.to_warehouse)}
	if any((row.item, row.warehouse) in inputs for row in outputs):
		frappe.throw(_("Cyclic route: output returns into a Delivery Challan input bucket."))


def lock_close_buckets(dc) -> None:
	lock_stock_valuation_period(shared=True)
	buckets = {(row.item, dc.to_warehouse) for row in dc.items}
	for name in get_linking_grns(dc.name, (1,), for_update=True):
		receipt = frappe.get_doc("MGK Goods Received Note", name, for_update=True)
		receipt.check_permission("read")
		buckets.update((row.item, receipt.warehouse) for row in receipt.items)
	for item, warehouse in sorted(buckets):
		lock_valuation_bucket({"item": item, "warehouse": warehouse})


def split_by_weight(total: float, weights: list[float]) -> list[float]:
	if not weights:
		return []
	if any(weight <= 0 for weight in weights):
		raise ValueError("Allocation weights must be positive.")
	weight_sum = sum(weights)
	shares = [flt(total * weight / weight_sum, 6) for weight in weights[:-1]]
	return [*shares, flt(total - sum(shares), 6)]


def build_consumption_entries(close, rows) -> list[dict]:
	return [
		{
			"item": row.item,
			"uom": row.stock_uom,
			"warehouse": close.warehouse,
			"voucher_type": close.doctype,
			"voucher_no": close.name,
			"voucher_detail_no": row.name,
			"posting_date": close.posting_date,
			"posting_time": close.posting_time,
			"qty": -row.remaining_stock_qty,
			"rate": 0,
			"is_cancelled": 0,
			"_result_key": f"close:{row.name}",
		}
		for row in rows
		if row.remaining_stock_qty > 0
	]


def build_allocations_and_links(close) -> tuple[list[dict], list[dict]]:
	allocations, links = [], []
	weights = [row.stock_qty for row in close.outputs]
	for output in close.outputs:
		output.allocated_value = 0
	for row in close.items:
		if not row.consumption_sle:
			continue
		values = split_by_weight(row.own_value, weights)
		quantities = split_by_weight(row.remaining_stock_qty, weights)
		for output, value, quantity in zip(close.outputs, values, quantities, strict=True):
			allocation, link = get_allocation_and_link(row, output, value, quantity)
			allocations.append(allocation)
			links.append(link)
			output.allocated_value = flt(output.allocated_value + value, 6)
	for output in close.outputs:
		output.allocated_rate = flt(output.allocated_value / output.stock_qty, 6)
	return allocations, links


def get_allocation_and_link(row, output, value, quantity):
	stock_rate = flt(frappe.db.get_value("YRP Stock Ledger Entry", output.output_receipt_sle, "rate"))
	allocation = {
		"source_row": row.name,
		"source_sle": row.consumption_sle,
		"target_sle": output.output_receipt_sle,
		"item": output.item,
		"quantity": quantity,
		"old_rate": stock_rate,
		"new_rate": stock_rate + value / output.stock_qty,
		"difference": value,
		"allocation_weight": output.stock_qty,
		"stock_dimensions": "{}",
	}
	link = {
		"source_row": row.name,
		"consumption_sle": row.consumption_sle,
		"output_receipt_sle": output.output_receipt_sle,
		"input_quantity": quantity,
		"allocation_weight": output.stock_qty,
		"stock_dimensions": "{}",
	}
	return allocation, link
