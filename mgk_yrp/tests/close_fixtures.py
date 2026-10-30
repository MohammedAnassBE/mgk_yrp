from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_adjustment,
)

from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.tests.fixtures import (
	close_dc,
	make_conversion_input,
	make_delivery_challan,
	make_item,
	make_job_work_grn,
	make_po_grn,
	make_process,
	make_purchase_order,
	make_supplier,
	make_uom,
	make_warehouse,
	run_adjustments,
	set_process_outputs,
)

ADJUSTMENT = "yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment"
CLOSE = "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan_close.mgk_delivery_challan_close"
REOPEN = "mgk_yrp.job_work.reopen"


class CloseTestCase(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.enterContext(patch("frappe.enqueue"))
		# Tests drive process_adjustment themselves, including reversals and retries.
		self.enqueue_adjustment = self.enterContext(patch(f"{ADJUSTMENT}.enqueue_adjustment"))
		for target in (ADJUSTMENT, CLOSE):
			setting = patch(f"{target}.is_stock_adjustment_enabled", return_value=True)
			setting.start()
			self.addCleanup(setting.stop)
		self.owner = make_supplier(is_company_location=1)
		self.supplier = make_supplier()
		self.purchase_supplier = make_supplier()
		self.main = make_warehouse(supplier=self.owner)
		self.destination = make_warehouse(supplier=self.supplier)
		self.process_name = make_process()
		_, self.output_item = make_conversion_input(self.process_name, [])
		_, self.raw_item = make_conversion_input(self.process_name, [(self.output_item, 1, 1)])

	def make_input(self, quantity=50, rate=100, item=None):
		order = make_purchase_order(
			supplier=self.purchase_supplier,
			warehouse=self.main,
			items=[
				{
					"item": item or self.raw_item,
					"qty": quantity,
					"rate": rate,
				}
			],
		)
		return make_po_grn(order)

	def make_challan(self, quantity=50, items=None, **header):
		return make_delivery_challan(
			from_warehouse=self.main,
			to_supplier=self.supplier,
			to_warehouse=self.destination,
			process_name=self.process_name,
			items=items or [{"item": self.raw_item, "qty": quantity}],
			**header,
		)

	def make_output(self, challans, quantity=60, items=None, **header):
		return make_job_work_grn(
			supplier=self.supplier,
			warehouse=self.main,
			delivery_challans=[dc.name for dc in challans],
			items=items or [{"item": self.output_item, "qty": quantity, "rate": 10}],
			**header,
		)

	def make_cycle(self):
		self.make_input()
		challan = self.make_challan()
		receipt = self.make_output([challan])
		return challan, receipt

	def make_two_stage_chain(self):
		self.make_input(quantity=100, rate=50)
		first = self.make_challan()
		outputs = [self.make_output([first], quantity=12) for _ in range(5)]
		upstream = close_dc(first)
		run_adjustments(upstream.doctype, upstream.name)
		second = self.make_challan(items=[{"item": self.output_item, "qty": 60}])
		finished_item = make_item(stock_uom=make_uom("Kg"))
		set_process_outputs(self.output_item, self.process_name, [(finished_item, 1, 1)])
		receipt = self.make_output([second], items=[{"item": finished_item, "qty": 60, "rate": 20}])
		downstream = close_dc(second)
		run_adjustments(downstream.doctype, downstream.name)
		return upstream, downstream, outputs, receipt

	def get_overlay(self, receipt):
		return sum(row.valuation_adjustment_value for row in get_voucher_sles(receipt.doctype, receipt.name))

	def get_links(self, close):
		return frappe.get_all(
			"YRP Stock Valuation Production Link",
			filters={
				"source_doctype": close.doctype,
				"source_name": close.name,
				"active": 1,
			},
			fields=["consumption_sle", "output_receipt_sle", "allocation_weight", "input_quantity"],
		)

	def queue_receipt_adjustment(self, receipt, difference=100, source=None):
		entry = get_voucher_sles(receipt.doctype, receipt.name)[0]
		return create_adjustment(
			adjustment_type="Purchase Invoice Rate Difference",
			source_doctype=receipt.doctype,
			source_name=receipt.name,
			effective_date=receipt.posting_date,
			enqueue=False,
			allocations=[
				{
					"source_row": receipt.items[0].name,
					"source_sle": source,
					"target_sle": entry.name,
					"item": entry.item,
					"quantity": entry.qty,
					"old_rate": entry.rate,
					"new_rate": entry.rate + difference / entry.qty,
					"difference": difference,
					"allocation_weight": entry.qty,
					"stock_dimensions": "{}",
				}
			],
		)
