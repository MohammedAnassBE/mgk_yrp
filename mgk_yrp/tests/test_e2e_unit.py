from copy import deepcopy
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call, patch

import frappe
from frappe.model.base_document import BaseDocument

from mgk_yrp.job_work.reopen import get_guard_blockers, get_reopen_blockers, validate_reopen
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan_close.mgk_delivery_challan_close import (
	MGKDeliveryChallanClose,
)
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice import MGKPurchaseInvoice
from mgk_yrp.stock.backdating import validate_backdated_cancel
from mgk_yrp.tests.test_review_unit import throw_validation
from mgk_yrp.tests.valuation_fixtures import committed_stock_records, process_adjustment, valuation

REOPEN = "mgk_yrp.job_work.reopen"
BACKDATING = "mgk_yrp.stock.backdating"
GRN = "mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note"


class TestStatusGuards(TestCase):
	def setUp(self):
		self.database = Mock()
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", side_effect=throw_validation))
		self.enterContext(patch("frappe.flags", frappe._dict(mute_messages=False)))
		for module in (REOPEN, BACKDATING, GRN):
			self.enterContext(patch(f"{module}._", side_effect=lambda text: text))
		self.close = SimpleNamespace(
			doctype="MGK Delivery Challan Close",
			name="CLOSE-1",
			delivery_challan="DC-1",
			posting_date="2026-01-01",
			stock_valuation_adjustment="SVA-1",
			set_onload=Mock(),
		)

	def test_close_load_returns_only_valuation_status_without_sva_permission(self):
		self.database.get_value.return_value = "Reversal Queued"
		with patch("frappe.get_doc", side_effect=frappe.PermissionError):
			MGKDeliveryChallanClose.onload(self.close)
		self.close.set_onload.assert_called_once_with("valuation_status", "Reversal Queued")
		self.database.get_value.assert_called_once_with("YRP Stock Valuation Adjustment", "SVA-1", "status")

	def test_cancelled_invoice_load_checks_all_unfinished_adjustments(self):
		invoice = SimpleNamespace(doctype="MGK Purchase Invoice", name="PI-1", docstatus=2, set_onload=Mock())
		with (
			patch("frappe.get_doc", side_effect=frappe.PermissionError),
			patch("frappe.get_all", return_value=[{"name": "reversal"}]) as get_all,
		):
			MGKPurchaseInvoice.onload(invoice)
			invoice.set_onload.assert_called_with("valuation_pending", True)
			self.assertEqual(
				get_all.call_args.kwargs["filters"],
				{
					"source_doctype": invoice.doctype,
					"source_name": invoice.name,
					"docstatus": 1,
					"status": ["not in", ["Completed", "Reversed"]],
				},
			)
			get_all.return_value = []
			MGKPurchaseInvoice.onload(invoice)
			invoice.set_onload.assert_called_with("valuation_pending", False)
			invoice.docstatus = 1
			get_all.reset_mock()
			MGKPurchaseInvoice.onload(invoice)
			get_all.assert_not_called()

	def test_invoice_cancel_response_includes_current_valuation_pending(self):
		invoice = MGKPurchaseInvoice.__new__(MGKPurchaseInvoice)
		invoice.__dict__.update(
			doctype="MGK Purchase Invoice", name="PI-1", docstatus=2, _table_fieldnames={}
		)
		module = "mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice"
		with (
			patch.object(invoice, "sync_grn_links"),
			patch.object(invoice, "get_valid_dict", return_value=frappe._dict()),
			patch("frappe.get_all", return_value=[]) as get_all,
			patch(f"{module}.create_reversal") as reverse,
		):
			for adjustments in ([{"name": "reversal"}], []):
				with self.subTest(adjustments=adjustments):
					invoice.set("__onload", None)
					get_all.return_value = []
					reverse.side_effect = lambda *args: setattr(get_all, "return_value", adjustments)
					invoice.on_cancel()
					self.assertEqual(invoice.as_dict()["__onload"]["valuation_pending"], bool(adjustments))

	def test_backdated_cancel_names_later_voucher_for_user_and_manager(self):
		doc = SimpleNamespace(
			doctype="MGK Goods Received Note",
			name="GRN-1",
			posting_date="2026-01-01",
			posting_time="09:00:00",
		)
		later = frappe._dict(name="SLE-2", voucher_type="MGK Delivery Challan", voucher_no="DC-2")
		for roles in (["Stock User"], ["Stock Manager"]):
			with (
				self.subTest(roles=roles),
				patch(f"{BACKDATING}.lock_stock_buckets"),
				patch("frappe.get_roles", return_value=roles),
			):
				self.database.sql.return_value = [later]
				error = frappe.PermissionError if roles == ["Stock User"] else frappe.ValidationError
				with self.assertRaisesRegex(error, "MGK Delivery Challan DC-2.*newest"):
					validate_backdated_cancel(doc, buckets=[("item", "warehouse")])
			query = self.database.sql.call_args
			self.assertIn("ORDER BY sle.posting_datetime DESC", query.args[0])
			self.assertTrue(query.args[0].rstrip().endswith("FOR UPDATE"))
			self.assertTrue(query.kwargs["as_dict"])

	def test_reopen_collects_unique_blockers_and_throws_a_list(self):
		challan = SimpleNamespace(
			close_status="Closed", delivery_challan_close="CLOSE-1", check_permission=Mock()
		)
		with (
			patch(f"{REOPEN}.lock_reopen"),
			patch("frappe.get_doc", return_value=challan),
			patch(f"{REOPEN}.get_guard_blockers", return_value=["blocked", "blocked"]),
			patch(f"{REOPEN}.get_adjustment_blockers", return_value=["blocked", "other"]),
		):
			self.assertEqual(get_reopen_blockers(self.close), ["blocked", "other"])
			with self.assertRaises(frappe.ValidationError):
				validate_reopen(self.close)
		frappe.throw.assert_called_once_with(["blocked", "other"], as_list=True)
		challan.check_permission.assert_called_with("read")

	def test_receipt_guard_fails_for_a_missing_linked_invoice(self):
		receipt = SimpleNamespace(
			doctype="MGK Goods Received Note",
			name="GRN-1",
			flags=frappe._dict(),
			lock_sources=Mock(),
			reload=Mock(),
		)
		self.database.get_value.side_effect = ["PI-missing", None]
		with patch(f"{GRN}.validate_stock_dimensions"):
			with self.assertRaisesRegex(frappe.DoesNotExistError, "PI-missing not found"):
				MGKGoodsReceivedNote.before_cancel(receipt)

	def test_reopen_collection_mutes_intermediate_dialogs_and_restores_flag(self):
		def blocked(*args):
			self.assertTrue(frappe.flags.mute_messages)
			raise frappe.ValidationError("blocked")

		with (
			patch(f"{REOPEN}.validate_reversal_allowed", side_effect=blocked),
			patch(f"{REOPEN}.validate_stock_valuation_period", side_effect=blocked),
			patch(f"{REOPEN}.validate_reopen_backdating"),
		):
			self.assertEqual(get_guard_blockers(self.close), ["blocked", "blocked"])
		self.assertFalse(frappe.flags.mute_messages)
		with patch(f"{REOPEN}.validate_reversal_allowed", side_effect=RuntimeError("unexpected")):
			with self.assertRaisesRegex(RuntimeError, "unexpected"):
				get_guard_blockers(self.close)
		self.assertFalse(frappe.flags.mute_messages)


class TestValuationIsolation(TestCase):
	def setUp(self):
		self.database = Mock()
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.state = {"fixture": "pending"}
		self.checkpoints = {}
		self.database.savepoint.side_effect = lambda name: self.checkpoints.update(
			{name: deepcopy(self.state)}
		)
		self.database.rollback.side_effect = self.rollback

	def rollback(self, *, save_point=None):
		self.state.clear()
		self.state.update(self.checkpoints[save_point] if save_point else {})

	def test_worker_checkpoints_preserve_progress_without_commit_or_queue(self):
		enqueue = self.enterContext(patch.object(valuation, "enqueue_adjustment"))

		def worker(name):
			self.state["plan"] = "built"
			frappe.db.commit()
			self.state["partial"] = "discard"
			frappe.db.rollback()
			self.assertEqual(self.state, {"fixture": "pending", "plan": "built"})
			self.state["status"] = "Apply Failed"
			frappe.db.commit()
			valuation.enqueue_adjustment(name)
			raise frappe.ValidationError("retry later")

		with patch.object(valuation, "process_adjustment", side_effect=worker):
			with self.assertRaisesRegex(frappe.ValidationError, "retry later"):
				process_adjustment("SVA-1")
		self.assertEqual(self.state, {"fixture": "pending", "plan": "built", "status": "Apply Failed"})
		self.database.commit.assert_not_called()
		self.database.rollback.assert_called_once()
		self.assertIn(self.database.rollback.call_args.kwargs["save_point"], self.checkpoints)
		self.database.after_commit.run.assert_not_called()
		enqueue.assert_not_called()

	def test_committed_record_cleanup_removes_only_inserted_records_even_on_failure(self):
		documents = [
			SimpleNamespace(doctype="YRP Stock Valuation Adjustment", name="test-sva"),
			SimpleNamespace(doctype="YRP Stock Valuation Propagation Entry", name="test-entry"),
			SimpleNamespace(doctype="YRP Stock Valuation Production Link", name="test-link"),
		]
		with patch.object(BaseDocument, "db_insert", return_value=None):
			with self.assertRaisesRegex(RuntimeError, "failed test"), committed_stock_records():
				for doc in documents:
					BaseDocument.db_insert(doc)
				raise RuntimeError("failed test")
		self.assertEqual(
			self.database.delete.call_args_list,
			[call(doc.doctype, {"name": ["in", [doc.name]]}) for doc in reversed(documents)],
		)
		self.database.rollback.assert_called_once_with()
		self.database.commit.assert_called_once_with()
