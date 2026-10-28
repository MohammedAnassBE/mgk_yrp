from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

import frappe
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_reversal,
	retry_adjustment,
)

from mgk_yrp.job_work.reopen import finish_pending_reopens, finish_reopen, get_reopen_blockers
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import (
	make_delivery_challan_close,
	make_return_delivery_challan,
)
from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.tests.close_fixtures import ADJUSTMENT, REOPEN, CloseTestCase
from mgk_yrp.tests.fixtures import close_dc, make_item, make_return, make_uom, run_adjustments
from mgk_yrp.tests.test_stock_concurrency import worker_connection
from mgk_yrp.tests.valuation_fixtures import (
	committed_stock_records,
	process_adjustment,
	valuation_checkpoints,
)


class TestDCReopen(CloseTestCase):
	def test_c59_c69_shared_grn_reopens_both_closes_in_creation_order(self):
		self.assert_shared_grn_reopens(reverse=False)

	def test_c59_c69_shared_grn_reopens_both_closes_in_reverse_order(self):
		self.assert_shared_grn_reopens(reverse=True)

	def assert_shared_grn_reopens(self, *, reverse):
		self.make_input(quantity=100)
		challans = [self.make_challan(), self.make_challan()]
		receipt = self.make_output(challans)
		closes = []
		for challan in challans:
			close = close_dc(challan)
			run_adjustments(close.doctype, close.name)
			closes.append(close)
		self.assertEqual(self.get_overlay(receipt), 10000)
		order = closes[::-1] if reverse else closes
		for index, close in enumerate(order):
			close.cancel()
			run_adjustments(close.doctype, close.name)
			self.assertTrue(finish_reopen(close.name))
			self.assertEqual(self.get_overlay(receipt), 5000 * (1 - index))
			self.assertFalse(self.get_links(close))
			self.assertFalse(get_voucher_sles(close.doctype, close.name))
			self.assertEqual(
				frappe.db.get_value("MGK Delivery Challan", close.delivery_challan, "close_status"), "Open"
			)
		self.assertEqual([close.reload().reopen_status for close in closes], ["Reopened", "Reopened"])

	def test_shared_grn_waits_for_unfinished_sibling_reversal(self):
		self.make_input(quantity=100)
		first, second = self.make_challan(), self.make_challan()
		self.make_output([first, second])
		closes = []
		for challan in (first, second):
			close = close_dc(challan)
			run_adjustments(close.doctype, close.name)
			closes.append(close)
		closes[0].cancel()
		self.assert_preflight_rejects(closes[1], "Stock Valuation Adjustment")

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
		self.assert_preflight_rejects(close, adjustment)
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
		self.assert_preflight_rejects(close, adjustment)

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
		adjustment = self.queue_receipt_adjustment(receipt)
		self.assert_preflight_rejects(close, adjustment)

	def test_upstream_waits_for_downstream_reversal_and_finish(self):
		upstream, downstream, outputs, receipt = self.make_two_stage_chain()
		self.assert_preflight_rejects(upstream, downstream.name)
		downstream.cancel()
		run_adjustments(downstream.doctype, downstream.name)
		finish_reopen(downstream.name)
		downstream = close_dc(frappe.get_doc("MGK Delivery Challan", downstream.delivery_challan))
		run_adjustments(downstream.doctype, downstream.name)
		downstream.cancel()
		self.assert_preflight_rejects(upstream, downstream.name)
		run_adjustments(downstream.doctype, downstream.name)
		self.assertEqual(self.get_overlay(receipt), 0)
		self.assertTrue(self.get_links(downstream))
		self.assert_preflight_rejects(upstream, downstream.name)
		self.assertTrue(finish_reopen(downstream.name))
		upstream.cancel()
		run_adjustments(upstream.doctype, upstream.name)
		self.assertTrue(finish_reopen(upstream.name))
		self.assertEqual([self.get_overlay(row) for row in outputs], [0] * 5)
		self.assertEqual(self.get_overlay(receipt), 0)

	def test_failed_reversal_resumes_applied_entries_then_finishes(self):
		upstream, downstream, outputs, receipt = self.make_two_stage_chain()
		downstream.cancel()
		run_adjustments(downstream.doctype, downstream.name)
		finish_reopen(downstream.name)
		upstream.cancel()
		reversal = frappe.db.get_value(
			"YRP Stock Valuation Adjustment", {"reversal_of": upstream.stock_valuation_adjustment}, "name"
		)
		self.fail_after_first_reversal_entry(reversal)
		self.assertFalse(finish_reopen(upstream.name))
		self.assertTrue(self.get_links(upstream))
		applied = frappe.get_all(
			"YRP Stock Valuation Propagation Entry",
			filters={"adjustment": reversal, "status": "Applied"},
			pluck="name",
		)
		self.assertTrue(applied)
		retry_adjustment(reversal)
		run_adjustments(upstream.doctype, upstream.name)
		self.assertTrue(finish_reopen(upstream.name))
		self.assertEqual([self.get_overlay(row) for row in outputs], [0] * 5)
		self.assertEqual(self.get_overlay(receipt), 0)
		self.assertFalse(self.get_links(upstream))

	def fail_after_first_reversal_entry(self, reversal):
		from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment import yrp_stock_valuation_adjustment

		apply_entry = yrp_stock_valuation_adjustment._apply_propagation_entry
		calls = 0

		def fail_second_entry(name):
			nonlocal calls
			calls += 1
			if calls == 2:
				raise frappe.ValidationError("transient reversal failure")
			return apply_entry(name)

		with patch(f"{ADJUSTMENT}._apply_propagation_entry", side_effect=fail_second_entry):
			with self.assertRaisesRegex(frappe.ValidationError, "transient reversal failure"):
				process_adjustment(reversal)
		self.assertEqual(
			frappe.db.get_value("YRP Stock Valuation Adjustment", reversal, "status"), "Apply Failed"
		)

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
		self.enqueue_adjustment.reset_mock()
		close.cancel()
		self.enqueue_adjustment.assert_called_once()
		self.run_pending_reopen(close)
		self.assertEqual(challan.reload().close_status, "Reopening")
		run_adjustments(close.doctype, close.name)
		self.run_pending_reopen(close)
		self.assertEqual(challan.reload().close_status, "Open")
		self.assertIn(
			"mgk_yrp.job_work.reopen.finish_pending_reopens",
			frappe.get_hooks("scheduler_events")["cron"]["*/2 * * * *"],
		)

	def run_pending_reopen(self, close):
		get_all = frappe.get_all

		def test_records(doctype, *args, **kwargs):
			if doctype == close.doctype:
				return [close.name]
			return get_all(doctype, *args, **kwargs)

		with valuation_checkpoints(), patch(f"{REOPEN}.frappe.get_all", side_effect=test_records):
			finish_pending_reopens()

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


class TestDCReopenConcurrency(CloseTestCase):
	def setUp(self):
		self.enterContext(committed_stock_records())
		super().setUp()

	def test_c64_c68_upstream_reopen_waits_for_downstream_finish_without_deadlock(self):
		upstream, downstream, outputs, receipt = self.make_two_stage_chain()
		downstream.cancel()
		run_adjustments(downstream.doctype, downstream.name)
		frappe.db.commit()
		ready, waiting = Event(), Event()
		site, sites_path = frappe.local.site, frappe.local.sites_path

		def observe_upstream_parents(documents):
			if upstream.name in documents.get(upstream.doctype, ()):
				waiting.set()
			return lock_documents(documents)

		with ThreadPoolExecutor(max_workers=1) as pool:
			finisher = pool.submit(
				self.finish_after_upstream_waits, site, sites_path, downstream, ready, waiting
			)
			try:
				self.assertTrue(ready.wait(10), "Finish did not lock its Close parents")
				with patch("mgk_yrp.stock.dependencies.lock_documents", side_effect=observe_upstream_parents):
					upstream.cancel()
				frappe.db.commit()
			finally:
				waiting.set()
				frappe.db.rollback()
				self.assertTrue(finisher.result(timeout=20))
		run_adjustments(upstream.doctype, upstream.name)
		self.assertTrue(finish_reopen(upstream.name))
		self.assertEqual(downstream.reload().reopen_status, "Reopened")
		self.assertFalse(self.get_links(downstream))
		self.assertEqual([self.get_overlay(row) for row in outputs], [0] * 5)
		self.assertEqual(self.get_overlay(receipt), 0)

	def finish_after_upstream_waits(self, site, sites_path, close, ready, waiting):
		with worker_connection(site, sites_path):
			frappe.db.sql("SET SESSION innodb_lock_wait_timeout = 5")
			lock_documents(
				{
					"MGK Delivery Challan": [close.delivery_challan],
					"MGK Goods Received Note": [row.goods_received_note for row in close.outputs],
					close.doctype: [close.name],
				}
			)
			ready.set()
			if not waiting.wait(10):
				raise AssertionError("Upstream reopen did not request its dependency parents")
			finished = finish_reopen(close.name)
			frappe.db.commit()
			return finished
