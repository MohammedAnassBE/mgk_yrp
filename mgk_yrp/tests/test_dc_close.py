from unittest.mock import Mock, patch

import frappe
from frappe.utils import add_days, flt, nowdate
from yrp.stock.utils import get_stock_balance

from mgk_yrp.job_work.close_valuation import lock_close_buckets, split_by_weight
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import make_delivery_challan_close
from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.tests.close_fixtures import CLOSE, CloseTestCase
from mgk_yrp.tests.fixtures import (
	close_dc,
	make_delivery_challan,
	make_item,
	make_job_work_grn,
	make_return,
	make_supplier,
	make_uom,
	make_warehouse,
	run_adjustments,
)


class TestDCClose(CloseTestCase):
	def test_make_close_only_for_open_dc(self):
		self.make_input()
		challan = self.make_challan(submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "submitted"):
			make_delivery_challan_close(challan.name)
		challan.submit()
		returned = make_return(challan, {challan.items[0].name: 1})
		with self.assertRaisesRegex(frappe.ValidationError, "non-return"):
			make_delivery_challan_close(returned.name)
		close_dc(challan)
		with self.assertRaisesRegex(frappe.ValidationError, "Closed"):
			make_delivery_challan_close(challan.name)

	def test_make_close_requires_source_permission(self):
		challan, _ = self.make_cycle()
		with patch("frappe.model.document.Document.check_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				make_delivery_challan_close(challan.name)

	def test_close_blocked_by_draft_grn_link(self):
		self.make_input()
		challan = self.make_challan()
		receipt = self.make_output([challan], submit=False)
		close = close_dc(challan, submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, f"Draft GRN {receipt.name}"):
			close.submit()
		self.assertFalse(get_voucher_sles(close.doctype, close.name))

	def test_close_ignores_client_posting_date(self):
		challan, _ = self.make_cycle()
		close = close_dc(challan, submit=False)
		close.posting_date, close.posting_time = add_days(nowdate(), -1), "00:00:00"
		close.save()
		self.assertEqual(str(close.posting_date), nowdate())
		close.posting_date = add_days(nowdate(), -1)
		close.submit()
		self.assertEqual(str(close.posting_date), nowdate())
		self.assertEqual(
			str(get_voucher_sles(close.doctype, close.name)[0].posting_datetime.date()), nowdate()
		)

	def test_close_worked_example(self):
		self.make_input()
		challan = self.make_challan()
		receipts = [self.make_output([challan], quantity=qty) for qty in (10, 10, 12, 13, 15)]
		close = close_dc(challan)
		self.assertEqual((close.total_dc_value, close.total_output_qty), (5000, 60))
		self.assertEqual(close.value_per_unit, flt(5000 / 60, 6))
		self.assertEqual(len(run_adjustments(close.doctype, close.name)), 1)
		self.assertAlmostEqual(sum(self.get_overlay(receipt) for receipt in receipts), 5000, places=6)
		for receipt in receipts:
			self.assertAlmostEqual(
				self.get_overlay(receipt), 5000 * receipt.items[0].stock_qty / 60, places=5
			)
		self.assertEqual(get_stock_balance(self.raw_item, self.destination), 0)
		self.assertEqual(get_voucher_sles(close.doctype, close.name)[0].qty, -50)
		close.reload()
		self.assertEqual(sum(row.allocated_value for row in close.outputs), 5000)

	def test_close_allocates_own_dc_value_not_bucket_value(self):
		self.make_input()
		self.make_input(rate=120)
		self.make_challan()
		second = self.make_challan()
		receipt = self.make_output([second])
		close = close_dc(second)
		run_adjustments(close.doctype, close.name)
		self.assertEqual(self.get_overlay(receipt), 6000)
		self.assertEqual(
			(close.items[0].consumed_value, close.items[0].own_value, close.total_value_gap),
			(5000, 6000, -1000),
		)

	def test_close_links_every_consumption_to_every_output(self):
		second_item = make_item(stock_uom=make_uom("Kg"))
		self.make_input()
		self.make_input(item=second_item)
		challan = self.make_challan(
			items=[{"item": item, "qty": 50} for item in (self.raw_item, second_item)]
		)
		self.make_output(
			[challan], items=[{"item": self.output_item, "qty": qty, "rate": 10} for qty in (10, 20)]
		)
		close = close_dc(challan)
		links = self.get_links(close)
		self.assertEqual(len(links), 4)
		self.assertEqual(
			{(link.consumption_sle, link.output_receipt_sle) for link in links},
			{
				(row.consumption_sle, output.output_receipt_sle)
				for row in close.items
				for output in close.outputs
			},
		)
		for link in links:
			output = next(row for row in close.outputs if row.output_receipt_sle == link.output_receipt_sle)
			self.assertEqual(link.allocation_weight, output.stock_qty)
		for row in close.items:
			self.assertAlmostEqual(
				sum(link.input_quantity for link in links if link.consumption_sle == row.consumption_sle),
				50,
				places=6,
			)

	def test_close_rejects_incomplete_production_links(self):
		challan, _ = self.make_cycle()
		close = close_dc(challan, submit=False)
		with patch(f"{CLOSE}.register_production_links"):
			with self.assertRaisesRegex(frappe.ValidationError, "Incomplete production"):
				close.submit()

	def test_close_without_grn_is_loss(self):
		self.make_input()
		close = close_dc(self.make_challan())
		self.assertEqual((close.loss_value, close.total_dc_value), (5000, 5000))
		self.assertFalse(close.stock_valuation_adjustment)
		self.assertFalse(self.get_links(close))
		self.assertEqual(get_stock_balance(self.raw_item, self.destination), 0)

	def test_close_rejects_mixed_output_stock_uoms(self):
		self.make_input()
		challan = self.make_challan()
		pieces = make_item(stock_uom=make_uom("Nos"))
		self.make_output(
			[challan], items=[{"item": item, "qty": 10, "rate": 1} for item in (self.output_item, pieces)]
		)
		with self.assertRaisesRegex(frappe.ValidationError, "different stock UOMs"):
			close_dc(challan)

	def test_cutting_uses_same_per_unit_value(self):
		self.make_input(quantity=3)
		challan = self.make_challan(quantity=3)
		panels = [make_item(stock_uom=make_uom("Nos")) for _ in range(3)]
		self.make_output(
			[challan],
			items=[
				{"item": item, "qty": qty, "rate": 0} for item, qty in zip(panels, (2, 3, 5), strict=True)
			],
		)
		close = close_dc(challan)
		self.assertEqual([row.allocated_rate for row in close.outputs], [30, 30, 30])
		run_adjustments(close.doctype, close.name)
		self.assertEqual(sum(row.allocated_value for row in close.outputs), 300)

	def test_close_rejects_cyclic_route(self):
		for warehouse in (self.main, self.destination):
			with self.subTest(warehouse=warehouse):
				self.make_input()
				challan = self.make_challan()
				make_job_work_grn(
					supplier=self.supplier,
					warehouse=warehouse,
					items=[{"item": self.raw_item, "qty": 1, "rate": 1}],
					delivery_challans=[challan.name],
				)
				with self.assertRaisesRegex(frappe.ValidationError, "Cyclic route"):
					close_dc(challan)

	def test_returns_reduce_dc_value(self):
		challan, _ = self.make_cycle()
		make_return(challan, {challan.items[0].name: 10})
		close = close_dc(challan)
		self.assertEqual((close.total_dc_value, close.items[0].remaining_stock_qty), (4000, 40))
		self.assertEqual(get_voucher_sles(close.doctype, close.name)[0].qty, -40)

	def test_fully_returned_dc_closes_without_postings(self):
		challan, _ = self.make_cycle()
		make_return(challan, {challan.items[0].name: 50})
		close = close_dc(challan)
		self.assertEqual(close.total_dc_value, 0)
		self.assertFalse(get_voucher_sles(close.doctype, close.name))
		self.assertFalse(close.stock_valuation_adjustment)
		self.assertFalse(self.get_links(close))

	def test_grn_linked_to_two_dcs_gets_both_values(self):
		self.make_input(quantity=100)
		first, second = self.make_challan(), self.make_challan()
		receipt = self.make_output([first, second])
		for challan in (first, second):
			close = close_dc(challan)
			run_adjustments(close.doctype, close.name)
		self.assertEqual(self.get_overlay(receipt), 10000)

	def test_downstream_dc_revalues_via_propagation(self):
		challan, receipt = self.make_cycle()
		dyer = make_supplier()
		dye_warehouse = make_warehouse(supplier=dyer)
		downstream = make_delivery_challan(
			from_warehouse=self.main,
			to_supplier=dyer,
			to_warehouse=dye_warehouse,
			items=[{"item": self.output_item, "qty": 60}],
			process=self.process,
		)
		dyed_item = make_item(stock_uom=make_uom("Kg"))
		dyed = make_job_work_grn(
			supplier=dyer,
			warehouse=self.main,
			delivery_challans=[downstream.name],
			items=[{"item": dyed_item, "qty": 60, "rate": 5}],
		)
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		incoming = next(row for row in get_voucher_sles(downstream.doctype, downstream.name) if row.qty > 0)
		self.assertAlmostEqual(incoming.valuation_adjustment_value, 5000, places=5)
		second = close_dc(downstream)
		self.assertAlmostEqual(second.total_dc_value, 5600, places=5)
		run_adjustments(second.doctype, second.name)
		self.assertAlmostEqual(self.get_overlay(dyed), 5600, places=5)
		self.assertEqual(self.get_overlay(receipt), 5000)

	def test_close_throws_when_adjustment_setting_off(self):
		challan, _ = self.make_cycle()
		close = close_dc(challan, submit=False)
		with patch(f"{CLOSE}.is_stock_adjustment_enabled", return_value=False):
			with self.assertRaisesRegex(frappe.ValidationError, "Enable Apply Stock Adjustment"):
				close.submit()
		self.assertFalse(get_voucher_sles(close.doctype, close.name))

	def test_loss_close_allowed_when_setting_off(self):
		self.make_input()
		with patch(f"{CLOSE}.is_stock_adjustment_enabled", return_value=False):
			close = close_dc(self.make_challan())
		self.assertEqual(close.loss_value, 5000)

	def test_close_waits_for_pending_output_adjustment(self):
		challan, receipt = self.make_cycle()
		close = close_dc(challan, submit=False)
		self.queue_receipt_adjustment(receipt)
		with self.assertRaisesRegex(frappe.ValidationError, "Previous Valuation Update Is Not Complete"):
			close.submit()
		self.assertFalse(get_voucher_sles(close.doctype, close.name))

	def test_close_throws_on_stale_dc_receipt(self):
		challan, _ = self.make_cycle()
		incoming = next(row for row in get_voucher_sles(challan.doctype, challan.name) if row.qty > 0)
		frappe.db.set_value("YRP Stock Ledger Entry", incoming.name, "valuation_is_stale", 1)
		with self.assertRaisesRegex(frappe.ValidationError, "stale"):
			close_dc(challan)

	def test_close_throws_on_missing_receipt(self):
		challan, receipt = self.make_cycle()
		entry = get_voucher_sles(receipt.doctype, receipt.name)[0]
		frappe.db.set_value("YRP Stock Ledger Entry", entry.name, "is_cancelled", 1)
		with self.assertRaisesRegex(frappe.ValidationError, "Missing receipt"):
			close_dc(challan)

	def test_close_lock_order(self):
		challan, receipt = self.make_cycle()
		sequence = Mock()
		with (
			patch(f"{CLOSE}.lock_documents", wraps=lock_documents) as locks,
			patch(
				f"{CLOSE}.lock_close_buckets",
				wraps=lock_close_buckets,
			) as buckets,
		):
			sequence.attach_mock(locks, "parents")
			sequence.attach_mock(buckets, "buckets")
			close = close_dc(challan, submit=False)
			close.submit()
		self.assertTrue(buckets.called)
		for index, recorded in enumerate(sequence.mock_calls):
			if recorded[0] == "buckets":
				previous = sequence.mock_calls[index - 1]
				self.assertEqual(previous[0], "parents")
				self.assertIn("MGK Delivery Challan Close", previous.args[0])
		calls = [call.args[0] for call in locks.call_args_list]
		self.assertIn({"MGK Delivery Challan": [challan.name]}, calls)
		combined = next(call for call in calls if call.get("MGK Goods Received Note"))
		self.assertEqual(
			list(combined), ["MGK Delivery Challan", "MGK Goods Received Note", "MGK Delivery Challan Close"]
		)
		self.assertEqual(combined["MGK Goods Received Note"], [receipt.name])

	def test_grn_cancel_blocked_after_close(self):
		challan, receipt = self.make_cycle()
		close_dc(challan)
		with self.assertRaisesRegex(frappe.ValidationError, "reopen it before cancelling this GRN"):
			receipt.cancel()

	def test_split_by_weight_conserves_remainder(self):
		self.assertEqual(split_by_weight(1, [1, 1, 1]), [0.333333, 0.333333, 0.333334])
