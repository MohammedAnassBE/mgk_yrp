from unittest.mock import patch

import frappe
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_reversal,
	process_adjustment,
)

from mgk_yrp.job_work.reopen import finish_pending_reopens, finish_reopen, get_reopen_blockers
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import (
	make_delivery_challan_close,
	make_return_delivery_challan,
)
from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.tests.close_fixtures import REOPEN, CloseTestCase
from mgk_yrp.tests.fixtures import close_dc, make_return, run_adjustments


class TestDCReopen(CloseTestCase):
	def make_closed_cycle(self, *, process=True):
		challan, receipt = self.make_cycle()
		close = close_dc(challan)
		if process:
			run_adjustments(close.doctype, close.name)
		return challan, receipt, close

	def assert_preflight_rejects(self, close, message):
		before = frappe.db.count("YRP Stock Valuation Adjustment")
		with patch(
			f"{REOPEN}.create_reversal",
			wraps=create_reversal,
		) as reversal:
			with self.assertRaisesRegex(frappe.ValidationError, message):
				close.cancel()
			reversal.assert_not_called()
		self.assertEqual(frappe.db.count("YRP Stock Valuation Adjustment"), before)
		self.assertEqual(frappe.db.get_value(close.doctype, close.name, "docstatus"), 1)

	def test_reopen_preflight_runs_before_reversal(self):
		_, receipt, close = self.make_closed_cycle()
		target = get_voucher_sles(receipt.doctype, receipt.name)[0]
		frappe.db.set_value("YRP Stock Ledger Entry", target.name, "is_cancelled", 1)
		self.assert_preflight_rejects(close, "not an active incoming receipt")

	def test_reopen_rejected_when_later_linked_movement_exists(self):
		self.make_input(quantity=100)
		first, second = self.make_challan(), self.make_challan()
		self.make_output([first])
		self.make_output([second])
		close = close_dc(first)
		run_adjustments(close.doctype, close.name)
		later = close_dc(second)
		run_adjustments(later.doctype, later.name)
		self.assert_preflight_rejects(close, "later linked movements")

	def test_reopen_rejected_when_consumption_used_by_other_adjustment(self):
		_, receipt, close = self.make_closed_cycle()
		other = self.make_output([])
		adjustment = self.queue_receipt_adjustment(other, source=close.items[0].consumption_sle)
		process_adjustment(adjustment)
		self.assert_preflight_rejects(close, "Consumption is used by another")
		self.assertEqual(self.get_overlay(receipt), 5000)

	def test_reopen_rejected_when_consumption_is_propagation_node(self):
		input_receipt = self.make_input()
		challan = self.make_challan()
		self.make_output([challan])
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		adjustment = self.queue_receipt_adjustment(input_receipt)
		run_adjustments(input_receipt.doctype, input_receipt.name)
		self.assertTrue(
			frappe.db.exists(
				"YRP Stock Valuation Propagation Entry",
				{
					"adjustment": adjustment,
					"source_sle": close.items[0].consumption_sle,
				},
			)
		)
		self.assert_preflight_rejects(close, "Consumption is used by another")

	def test_reopen_rejected_when_own_adjustment_failed(self):
		for status in ("Calculation Failed", "Apply Failed"):
			with self.subTest(status=status):
				_, _, close = self.make_closed_cycle(process=False)
				frappe.db.set_value(
					"YRP Stock Valuation Adjustment", close.stock_valuation_adjustment, "status", status
				)
				self.assert_preflight_rejects(close, "valuation failure")

	def test_reopen_rejected_when_other_output_adjustment_pending(self):
		_, receipt, close = self.make_closed_cycle()
		self.queue_receipt_adjustment(receipt)
		self.assert_preflight_rejects(close, "unfinished valuation owns an output")

	def test_reopen_rejected_when_period_closed(self):
		_, _, close = self.make_closed_cycle()
		with patch(
			f"{REOPEN}.validate_stock_valuation_period",
			side_effect=frappe.ValidationError("Stock valuation is closed"),
		):
			self.assert_preflight_rejects(close, "Stock valuation is closed")

	def test_reopen_rejected_when_dc_not_closed(self):
		challan, _, close = self.make_closed_cycle()
		frappe.db.set_value(challan.doctype, challan.name, "close_status", "Open")
		self.assert_preflight_rejects(close, "must be Closed")

	def test_reopen_preflight_collects_independent_blockers(self):
		challan, _, close = self.make_closed_cycle(process=False)
		frappe.db.set_value(challan.doctype, challan.name, "close_status", "Open")
		frappe.db.set_value(
			"YRP Stock Valuation Adjustment", close.stock_valuation_adjustment, "status", "Apply Failed"
		)
		with patch(
			f"{REOPEN}.validate_reversal_allowed", side_effect=frappe.ValidationError("invalid receipt")
		):
			blockers = get_reopen_blockers(close)
		self.assertEqual(len(blockers), 3)

	def test_reopen_preflight_reads_current_later_movements(self):
		_, _, close = self.make_closed_cycle()
		with patch(f"{REOPEN}.frappe.db.sql", wraps=frappe.db.sql) as query:
			get_reopen_blockers(close)
		movement_queries = [
			call.args[0] for call in query.call_args_list if "sle.posting_datetime >=" in call.args[0]
		]
		self.assertTrue(movement_queries)
		self.assertTrue(all("FOR UPDATE" in sql for sql in movement_queries))

	def test_reopen_uses_persisted_audit(self):
		_, _, close = self.make_closed_cycle()
		adjustment = close.stock_valuation_adjustment
		consumption = close.items[0].consumption_sle
		close.stock_valuation_adjustment = None
		close.items[0].remaining_stock_qty = 0
		close.set("outputs", [])
		close.cancel()
		self.assertEqual(close.stock_valuation_adjustment, adjustment)
		self.assertEqual(close.items[0].remaining_stock_qty, 50)
		self.assertEqual(close.items[0].consumption_sle, consumption)
		self.assertEqual(close.reopen_status, "Reversing")

	def test_reopen_phase_one_creates_reversal_and_marks_reopening(self):
		challan, _, close = self.make_closed_cycle()
		close.cancel()
		close.reload()
		challan.reload()
		self.assertEqual(
			(close.docstatus, close.reopen_status, challan.close_status), (2, "Reversing", "Reopening")
		)
		self.assertEqual(challan.delivery_challan_close, close.name)
		reversals = frappe.get_all(
			"YRP Stock Valuation Adjustment",
			filters={
				"reversal_of": close.stock_valuation_adjustment,
			},
			fields=["name", "total_source_difference"],
		)
		self.assertEqual(len(reversals), 1)
		self.assertEqual(reversals[0].total_source_difference, -5000)
		self.assertEqual(len(get_voucher_sles(close.doctype, close.name)), 1)

	def test_reopening_blocks_links_returns_and_new_close(self):
		challan, receipt, close = self.make_closed_cycle()
		draft = self.make_output([], submit=False)
		close.cancel()
		for action in (
			lambda: self.make_output([challan], submit=False),
			lambda: make_return_delivery_challan(challan.name),
			lambda: make_delivery_challan_close(challan.name),
			lambda: close_dc(challan),
		):
			with self.assertRaisesRegex(frappe.ValidationError, "Reopening"):
				action()
		draft.append("delivery_challans", {"delivery_challan": challan.name})
		with self.assertRaisesRegex(frappe.ValidationError, "Reopening"):
			draft.save()
		with self.assertRaisesRegex(frappe.ValidationError, "reopen it before cancelling"):
			receipt.cancel()
		with self.assertRaisesRegex(frappe.ValidationError, "Reopening"):
			challan.reload().cancel()

	def test_reopening_blocks_draft_link_removal(self):
		challan, receipt = self.make_cycle()
		draft = self.make_output([challan], submit=False)
		frappe.db.set_value(challan.doctype, challan.name, "close_status", "Reopening")
		draft.set("delivery_challans", [])
		with self.assertRaisesRegex(frappe.ValidationError, "Reopening"):
			draft.save()
		self.assertTrue(
			frappe.db.exists(
				"MGK GRN Delivery Challan", {"parent": draft.name, "delivery_challan": challan.name}
			)
		)
		self.assertEqual(receipt.docstatus, 1)

	def test_reopening_blocks_existing_return_submit(self):
		challan, _ = self.make_cycle()
		returned = make_return(challan, {challan.items[0].name: 1}, submit=False)
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		close.cancel()
		with self.assertRaisesRegex(frappe.ValidationError, "Reopening"):
			returned.submit()

	def test_finish_reopen_waits_for_reversal(self):
		challan, _, close = self.make_closed_cycle()
		close.cancel()
		self.assertFalse(finish_reopen(close.name))
		self.assertEqual(len(get_voucher_sles(close.doctype, close.name)), 1)
		self.assertEqual(challan.reload().close_status, "Reopening")

	def test_finish_reopen_cancels_consumption_and_reopens_dc(self):
		challan, receipt, close = self.make_closed_cycle()
		consumption = close.items[0].consumption_sle
		close.cancel()
		run_adjustments(close.doctype, close.name)
		self.assertTrue(finish_reopen(close.name))
		self.assertEqual(frappe.db.get_value("YRP Stock Ledger Entry", consumption, "is_cancelled"), 1)
		self.assertFalse(self.get_links(close))
		self.assertAlmostEqual(self.get_overlay(receipt), 0, places=6)
		self.assertEqual(challan.reload().close_status, "Open")
		self.assertFalse(challan.delivery_challan_close)
		self.assertEqual(close.reload().reopen_status, "Reopened")
		self.assertTrue(finish_reopen(close.name))

	def test_finish_reopen_requires_cancel_permission(self):
		_, _, close = self.make_closed_cycle()
		close.cancel()
		with patch("frappe.model.document.Document.check_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				finish_reopen(close.name)

	def test_finish_reopen_rechecks_stock_cancellation_guard(self):
		challan, _, close = self.make_closed_cycle()
		close.cancel()
		run_adjustments(close.doctype, close.name)
		with patch(
			f"{REOPEN}.post_stock_entries", side_effect=frappe.ValidationError("new cancellation blocker")
		):
			with self.assertRaisesRegex(frappe.ValidationError, "new cancellation blocker"):
				finish_reopen(close.name)
		self.assertEqual(challan.reload().close_status, "Reopening")
		self.assertTrue(self.get_links(close))

	def test_dc_can_close_again_after_reopen(self):
		challan, receipt, close = self.make_closed_cycle()
		old_consumption = close.items[0].consumption_sle
		close.cancel()
		run_adjustments(close.doctype, close.name)
		finish_reopen(close.name)
		second = close_dc(challan)
		self.assertNotEqual(second.name, close.name)
		self.assertNotEqual(second.items[0].consumption_sle, old_consumption)
		run_adjustments(second.doctype, second.name)
		self.assertEqual(self.get_overlay(receipt), 5000)

	def test_loss_close_reopens_in_one_step(self):
		self.make_input()
		challan = self.make_challan()
		close = close_dc(challan)
		close.cancel()
		self.assertEqual(close.reload().reopen_status, "Reopened")
		self.assertEqual(challan.reload().close_status, "Open")
		self.assertFalse(close.stock_valuation_adjustment)
		self.assertTrue(finish_reopen(close.name))

	def test_finish_pending_reopens_scheduler(self):
		challan, _, close = self.make_closed_cycle()
		close.cancel()
		finish_pending_reopens()
		self.assertEqual(challan.reload().close_status, "Reopening")
		run_adjustments(close.doctype, close.name)
		finish_pending_reopens()
		self.assertEqual(challan.reload().close_status, "Open")
		self.assertIn(
			"mgk_yrp.job_work.reopen.finish_pending_reopens",
			frappe.get_hooks("scheduler_events")["cron"]["*/2 * * * *"],
		)

	def test_scheduler_rolls_back_failed_close_and_continues(self):
		with (
			patch(f"{REOPEN}.frappe.get_all", return_value=["failed", "ready"]),
			patch(f"{REOPEN}.finish_reopen", side_effect=[frappe.ValidationError("blocked"), True]) as finish,
			patch(f"{REOPEN}.frappe.db.rollback") as rollback,
			patch(f"{REOPEN}.frappe.db.commit") as commit,
			patch(f"{REOPEN}.frappe.log_error") as log,
		):
			finish_pending_reopens()
		self.assertEqual([call.args[0] for call in finish.call_args_list], ["failed", "ready"])
		rollback.assert_called_once()
		commit.assert_called_once()
		log.assert_called_once()
