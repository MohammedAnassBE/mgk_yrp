import frappe
from frappe import _
from frappe.utils import flt
from yrp.stock.stock_ledger import lock_valuation_bucket
from yrp.yrp.doctype.yrp_item.yrp_item import get_parent_item
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	find_receipt_sle,
)
from yrp.yrp_stock.doctype.yrp_stock_valuation_closing.yrp_stock_valuation_closing import (
	lock_stock_valuation_period,
)

from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import get_linking_grns
from mgk_yrp.stock.ledger import get_dimension_values
from mgk_yrp.stock.process_conversion import get_process_conversion


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
	challan = frappe.get_doc("MGK Delivery Challan", delivery_challan)
	tracing = OutputTracing(challan)
	for name in get_linking_grns(delivery_challan, (1,), for_update=True):
		receipt = frappe.get_doc("MGK Goods Received Note", name, for_update=True)
		receipt.check_permission("read")
		for row in receipt.items:
			if row.stock_qty <= 0:
				continue
			input_item = tracing.get_input_item(receipt, row)
			if not input_item:
				continue
			weight = tracing.get_weight(input_item, row, receipt)
			outputs.append(get_output_snapshot(receipt, row, input_item, weight))
	return outputs


def get_output_snapshot(receipt, row, input_item, weight):
	ledger = get_active_receipt(receipt.doctype, receipt.name, row.name)
	return frappe._dict(
		goods_received_note=receipt.name,
		goods_received_note_item=row.name,
		item=row.item,
		warehouse=receipt.warehouse,
		stock_uom=row.stock_uom,
		stock_qty=row.stock_qty,
		input_item=input_item,
		allocation_weight=weight,
		stock_rate=ledger.rate,
		output_receipt_sle=ledger.name,
	)


class OutputTracing:
	"""Resolve receipt rows to distinct input items and conversion weights."""

	def __init__(self, challan):
		self.challan = challan
		self.templates = {}
		self.conversions = {}
		self.attributes = {}

	def get_template(self, item):
		if item not in self.templates:
			self.templates[item] = get_parent_item(item)
		return self.templates[item]

	def get_conversions(self, item, process):
		key = (self.get_template(item), process)
		if key not in self.conversions:
			self.conversions[key] = get_process_conversion(item, process)
		return self.conversions[key]

	def get_attributes(self, item):
		if item not in self.attributes:
			self.attributes[item] = {
				row.attribute: row.attribute_value
				for row in frappe.get_all(
					"Item Variant Attribute",
					filters={"parent": item, "parenttype": "Item"},
					fields=["attribute", "attribute_value"],
				)
				if row.attribute_value not in (None, "")
			}
		return self.attributes[item]

	def get_candidates(self, challan, output):
		template = self.get_template(output)
		candidates = []
		for item in dict.fromkeys(row.item for row in challan.items):
			conversions = self.get_conversions(item, challan.process_name)
			mapped = any(self.get_template(row.item) == template for row in conversions)
			if mapped or (not conversions and self.get_template(item) == template):
				candidates.append(item)
		if len(candidates) > 1:
			attributes = self.get_attributes(output)
			candidates = [item for item in candidates if self.has_matching_attributes(item, attributes)]
		return candidates

	def has_matching_attributes(self, item, output_attributes):
		attributes = self.get_attributes(item)
		shared = attributes.keys() & output_attributes.keys()
		return all(attributes[key] == output_attributes[key] for key in shared)

	def get_input_item(self, receipt, output):
		if output.get("delivery_challan_item"):
			return self.get_linked_input_item(receipt, output)
		candidates = self.get_candidates(self.challan, output.item)
		if len(candidates) == 1:
			return candidates[0]
		if not candidates and self.has_other_input(receipt, output.item):
			return None
		self.throw_untraceable(receipt, output)

	def get_linked_input_item(self, receipt, output):
		for source in self.challan.items:
			if source.name == output.delivery_challan_item:
				return source.item
		for link in receipt.delivery_challans:
			if link.delivery_challan == self.challan.name:
				continue
			challan = frappe.get_doc("MGK Delivery Challan", link.delivery_challan)
			challan.check_permission("read")
			if any(row.name == output.delivery_challan_item for row in challan.items):
				return None
		self.throw_untraceable(receipt, output)

	def has_other_input(self, receipt, output):
		for link in receipt.delivery_challans:
			if link.delivery_challan == self.challan.name:
				continue
			challan = frappe.get_doc("MGK Delivery Challan", link.delivery_challan)
			challan.check_permission("read")
			if len(self.get_candidates(challan, output)) == 1:
				return True
		return False

	def get_weight(self, input_item, output, receipt):
		conversions = self.get_conversions(input_item, self.challan.process_name)
		if not conversions:
			return output.stock_qty
		matches = [row for row in conversions if self.get_template(row.item) == self.get_template(output.item)]
		if len(matches) != 1:
			self.throw_untraceable(receipt, output)
		conversion = matches[0]
		if flt(conversion.from_qty) <= 0 or flt(conversion.to_qty) <= 0:
			frappe.throw(_("Process Conversion quantities must be greater than zero for {0}.").format(input_item))
		return output.stock_qty * flt(conversion.from_qty) / flt(conversion.to_qty)

	def throw_untraceable(self, receipt, output):
		frappe.throw(
			_("Row {0} of {1}: {2} cannot be traced to one item of Delivery Challan {3}.").format(
				output.idx, receipt.name, output.item, self.challan.name
			)
		)


def validate_outputs(dc, outputs) -> None:
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
	challan = frappe.get_doc("MGK Delivery Challan", close.delivery_challan)
	sources = {row.name: row for row in challan.items}
	return [
		{
			**get_dimension_values(sources[row.delivery_challan_item]),
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
	for output in close.outputs:
		output.allocated_value = 0
	for row in close.items:
		if not row.consumption_sle:
			continue
		outputs = [output for output in close.outputs if output.input_item == row.item]
		weights = [output.allocation_weight for output in outputs]
		values = split_by_weight(row.own_value, weights)
		quantities = split_by_weight(row.remaining_stock_qty, weights)
		for output, value, quantity in zip(outputs, values, quantities, strict=True):
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
		"allocation_weight": output.allocation_weight,
		"stock_dimensions": "{}",
	}
	link = {
		"source_row": row.name,
		"consumption_sle": row.consumption_sle,
		"output_receipt_sle": output.output_receipt_sle,
		"input_quantity": quantity,
		"allocation_weight": output.allocation_weight,
		"stock_dimensions": "{}",
	}
	return allocation, link
