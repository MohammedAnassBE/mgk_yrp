from unittest.mock import patch

import frappe
from yrp.stock.utils import get_stock_balance

from mgk_yrp.job_work.close_valuation import get_dc_item_values
from mgk_yrp.job_work.dc_from_grn import make_delivery_challan_from_grns
from mgk_yrp.job_work.grn_from_dc import make_job_work_grn
from mgk_yrp.job_work.process_plan import PLAN_DOCTYPE, save_process_plan
from mgk_yrp.job_work.reopen import finish_reopen
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import mark_as_received
from mgk_yrp.stock.item_editor import get_item_details
from mgk_yrp.stock.ledger import assert_transfer_pairs, get_voucher_sles
from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import (
	close_dc,
	dimensioned_items,
	make_item,
	make_process,
	make_purchase_invoice,
	make_purchase_order,
	make_supplier,
	make_warehouse,
	run_adjustments,
	set_process_outputs,
)


class TestJobWorkChain(CloseTestCase):
	def setUp(self):
		super().setUp()
		self.enterContext(patch("mgk_yrp.purchase.revaluation.is_stock_adjustment_enabled", return_value=True))
		frappe.db.set_value("Supplier", {"mgk_is_head_office": 1}, "mgk_is_head_office", 0)
		frappe.get_doc("Supplier", self.owner).update({"mgk_is_head_office": 1}).save()
		self.receiving_location = make_supplier(is_company_location=1)
		self.receiving_warehouse = make_warehouse(supplier=self.receiving_location)
		self.next_supplier = make_supplier()
		self.next_warehouse = make_warehouse(supplier=self.next_supplier)
		self.next_process = make_process()
		self.finished_item = make_item(stock_uom="Kg")
		set_process_outputs(self.output_item, self.next_process, [(self.finished_item, 1, 1)])
		self.buckets = [(item, warehouse)
			for item in (self.raw_item, self.output_item, self.finished_item)
			for warehouse in (self.main, self.destination, self.receiving_warehouse, self.next_warehouse)]

	def test_j22_full_chain_and_complete_reversal(self):
		initial = self.stock_snapshot()
		order, purchase_receipt, first = self.receive_purchase()
		intermediate = self.receive_planned_output(first)
		second, moves = self.dispatch_via_head_office(intermediate)
		finished = self.receive_finished_output(second)
		self.assertEqual(get_dc_item_values(second)[0].delivered_value, 600)
		upstream = close_dc(first)
		run_adjustments(upstream.doctype, upstream.name)
		self.assertEqual(get_dc_item_values(second)[0].delivered_value, 5600)
		self.assert_receipt_value(intermediate, 5600)
		self.assert_receipt_value(finished, 1200)
		downstream = close_dc(second)
		run_adjustments(downstream.doctype, downstream.name)
		self.assert_close_allocations(upstream, 5000)
		self.assert_close_allocations(downstream, 5600)
		self.assert_receipt_value(finished, 6800)
		invoice = self.bill_finished_output(finished)
		self.assert_receipt_value(finished, 6920)
		self.reverse_chain(invoice, downstream, finished, upstream, second, intermediate, first, moves)
		self.assert_purchase_baseline(purchase_receipt)
		purchase_receipt.reload().cancel()
		order.reload().cancel()
		self.assertEqual(self.stock_snapshot(), initial)

	def receive_purchase(self):
		order = make_purchase_order(supplier=self.purchase_supplier, warehouse=self.destination,
			delivery_location=self.supplier, deliver_to_supplier=1, process_name=self.process_name,
			items=[{"item": self.raw_item, "qty": 50, "rate": 100}])
		result = mark_as_received(order.name)
		receipt = frappe.get_doc("MGK Goods Received Note", result["goods_received_note"])
		challan = frappe.get_doc("MGK Delivery Challan", result["delivery_challan"])
		self.assertEqual((receipt.docstatus, challan.docstatus), (1, 1))
		self.assertEqual(receipt.total_amount, 5000)
		self.assertEqual(challan.goods_received_note, receipt.name)
		self.assert_transfer(challan)
		return order, receipt, challan

	def receive_planned_output(self, challan):
		plan = frappe.get_doc({"doctype": PLAN_DOCTYPE,
			"items": dimensioned_items([{"item": self.output_item, "qty": 60}])})
		self.assertEqual(save_process_plan(challan.name, get_item_details(plan)), challan.name)
		receipt = make_job_work_grn(challan.name)
		self.assertEqual([row.item for row in receipt.items], [self.output_item])
		self.assertEqual(receipt.items[0].qty, 0)
		receipt.delivery_location, receipt.warehouse = self.receiving_location, self.receiving_warehouse
		receipt.items[0].qty, receipt.items[0].rate = 60, 10
		receipt.insert().submit()
		return receipt

	def dispatch_via_head_office(self, receipt):
		result = make_delivery_challan_from_grns([receipt.name], self.next_process, self.next_supplier, 1)
		challan = frappe.get_doc("MGK Delivery Challan", result["delivery_challan"])
		moves = [frappe.get_doc("YRP Stock Entry", name) for name in result["stock_entries"]]
		self.assertEqual(len(moves), 1)
		move = moves[0]
		self.assertEqual((move.docstatus, move.purpose, move.skip_transit), (1, "Send to Warehouse", 1))
		self.assertEqual((move.from_warehouse, move.to_warehouse), (self.receiving_warehouse, self.main))
		self.assertEqual((challan.from_warehouse, challan.to_warehouse), (self.main, self.next_warehouse))
		self.assertEqual(challan.items[0].goods_received_note_item, receipt.items[0].name)
		self.assertEqual({entry.warehouse for entry in get_voucher_sles(move.doctype, move.name)},
			{self.receiving_warehouse, self.main})
		self.assert_transfer(move)
		self.assert_transfer(challan)
		return challan, moves

	def receive_finished_output(self, challan):
		receipt = make_job_work_grn(challan.name)
		self.assertEqual([row.item for row in receipt.items], [self.finished_item])
		receipt.items[0].qty, receipt.items[0].rate = 60, 20
		receipt.insert().submit()
		return receipt

	def bill_finished_output(self, receipt):
		invoice = make_purchase_invoice(against="Job Work", supplier=self.next_supplier,
			grns=[receipt], rates={receipt.items[0].name: 22})
		run_adjustments(invoice.doctype, invoice.name)
		return invoice

	def reverse_chain(self, invoice, downstream, finished, upstream, second, intermediate, first, moves):
		invoice.reload().cancel()
		run_adjustments(invoice.doctype, invoice.name)
		self.assert_receipt_value(finished, 6800)
		self.reopen_close(downstream)
		self.assert_receipt_value(finished, 1200)
		finished.reload().cancel()
		self.reopen_close(upstream)
		self.assertEqual(get_dc_item_values(second.reload())[0].delivered_value, 600)
		self.assert_receipt_value(intermediate, 600)
		second.reload().cancel()
		self.assertTrue(all(move.reload().docstatus == 2 for move in moves))
		self.assertEqual(get_stock_balance(self.output_item, self.receiving_warehouse), 60)
		intermediate.reload().cancel()
		first.reload().cancel()
		for close in (upstream, downstream):
			self.assertFalse(self.get_links(close))

	def reopen_close(self, close):
		close.reload().cancel()
		run_adjustments(close.doctype, close.name)
		self.assertTrue(finish_reopen(close.name))
		self.assertEqual(frappe.db.get_value("MGK Delivery Challan", close.delivery_challan, "close_status"), "Open")

	def assert_close_allocations(self, close, value):
		close.reload()
		self.assertEqual(sum(row.own_value for row in close.items), value)
		self.assertEqual([row.allocation_weight for row in close.outputs], [60])
		links = self.get_links(close)
		self.assertEqual([row.allocation_weight for row in links], [60])
		self.assertEqual([row.input_quantity for row in links], [close.items[0].remaining_stock_qty])

	def assert_receipt_value(self, receipt, value):
		entries = get_voucher_sles(receipt.doctype, receipt.name)
		self.assertAlmostEqual(sum(row.qty * row.rate + row.valuation_adjustment_value for row in entries), value, places=5)

	def assert_transfer(self, document):
		entries = document.get_sl_entries() if document.doctype == "YRP Stock Entry" else document.get_stock_entries()
		assert_transfer_pairs(document.doctype, document.name, expected_entries=entries)

	def stock_snapshot(self):
		return {(item, warehouse): self.bucket_balance(item, warehouse) for item, warehouse in self.buckets}

	def bucket_balance(self, item, warehouse):
		value = frappe.db.sql("""SELECT COALESCE(SUM(stock_value_difference), 0)
			FROM `tabYRP Stock Ledger Entry` WHERE item = %s AND warehouse = %s AND is_cancelled = 0""",
			(item, warehouse))[0][0]
		return (get_stock_balance(item, warehouse), round(float(value), 5))

	def assert_purchase_baseline(self, receipt):
		self.assertEqual(receipt.reload().docstatus, 1)
		for item, warehouse in self.buckets:
			expected = (50, 5000) if (item, warehouse) == (self.raw_item, self.main) else (0, 0)
			self.assertEqual(self.bucket_balance(item, warehouse), expected)
