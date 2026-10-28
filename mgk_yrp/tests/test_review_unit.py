from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call, patch

import frappe
from frappe.model.document import Document

from mgk_yrp.job_work.reopen import get_adjustment_blockers
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import MGKDeliveryChallan
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan_close.mgk_delivery_challan_close import (
	MGKDeliveryChallanClose,
)
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice import MGKPurchaseInvoice
from mgk_yrp.purchase.revaluation import create_invoice_adjustment
from mgk_yrp.stock.backdating import validate_backdated_cancel, validate_backdated_posting
from mgk_yrp.stock.ledger import assert_transfer_pairs
from mgk_yrp.stock.locking import lock_stock_buckets

BACKDATING = "mgk_yrp.stock.backdating"
LOCKING = "mgk_yrp.stock.locking"
LEDGER = "mgk_yrp.stock.ledger"
GRN = "mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note"
DC = "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan"
CLOSE = "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan_close.mgk_delivery_challan_close"
REVALUATION = "mgk_yrp.purchase.revaluation"
INVOICE = "mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice"


def throw_validation(message, *args, **kwargs):
	raise frappe.ValidationError(message)


class TestReviewUnit(TestCase):
	"""Lifecycle guards without a site, database, or Redis connection."""

	def setUp(self):
		self.database = Mock()
		for target, value in (("frappe.db", self.database), ("frappe.throw", throw_validation)):
			mocked = patch(target, value, create=True)
			mocked.start()
			self.addCleanup(mocked.stop)
		for module in (BACKDATING, LEDGER, GRN, DC, CLOSE, REVALUATION):
			translation = patch(f"{module}._", side_effect=lambda text: text)
			translation.start()
			self.addCleanup(translation.stop)
		self.doc = SimpleNamespace(
			doctype="MGK Goods Received Note",
			name="receipt",
			posting_date="2026-01-01",
			posting_time="09:00:00",
		)
		self.buckets = [("yarn", "supplier"), ("yarn", "main")]

	def test_bucket_locks_are_canonical_and_follow_period_lock(self):
		sequence = Mock()
		with (
			patch(f"{LOCKING}.lock_stock_valuation_period", sequence.period),
			patch(f"{LOCKING}.lock_valuation_bucket", sequence.bucket),
		):
			lock_stock_buckets([*self.buckets, self.buckets[0]])
		self.assertEqual(
			sequence.mock_calls,
			[
				call.period(shared=True),
				call.bucket({"item": "yarn", "warehouse": "main"}),
				call.bucket({"item": "yarn", "warehouse": "supplier"}),
			],
		)

	def test_backdated_post_checks_current_movements_after_bucket_locks(self):
		sequence = Mock()
		with (
			patch(f"{BACKDATING}.lock_stock_buckets", sequence.lock),
			patch(f"{BACKDATING}.is_backdated", return_value=True),
			patch(f"{BACKDATING}.require_stock_manager", sequence.role),
			patch(f"{BACKDATING}.validate_linked_movements", sequence.check),
		):
			validate_backdated_posting(self.doc, self.buckets)
		self.assertEqual(
			sequence.mock_calls,
			[call.lock(self.buckets), call.role(), call.check(self.doc, self.buckets, for_update=True)],
		)

	def test_cancel_checks_current_movements_after_bucket_locks(self):
		sequence = Mock()
		sequence.later.return_value = True
		with (
			patch(f"{BACKDATING}.lock_stock_buckets", sequence.lock),
			patch(f"{BACKDATING}.has_later_movements", sequence.later),
			patch(f"{BACKDATING}.require_stock_manager", sequence.role),
			patch(f"{BACKDATING}.validate_linked_movements", sequence.linked),
		):
			validate_backdated_cancel(self.doc, buckets=self.buckets)
		self.assertEqual([entry[0] for entry in sequence.mock_calls], ["lock", "later", "role", "linked"])
		self.assertTrue(sequence.later.call_args.kwargs["for_update"])
		self.assertTrue(sequence.linked.call_args.kwargs["for_update"])

	def test_movement_and_production_queries_are_current_reads(self):
		self.database.sql.return_value = []
		with patch(f"{BACKDATING}.lock_stock_buckets"):
			validate_backdated_cancel(self.doc, buckets=self.buckets)
		queries = [entry.args[0] for entry in self.database.sql.call_args_list]
		self.assertEqual(len(queries), 4)
		self.assertTrue(all(query.strip().endswith("FOR UPDATE") for query in queries))
		self.assertEqual(queries[-1].count("FOR UPDATE"), 2)

	def test_cancel_reloads_persisted_children_and_timestamp_under_source_locks(self):
		for controller, module in ((MGKGoodsReceivedNote, GRN), (MGKDeliveryChallan, DC)):
			with self.subTest(controller=controller.__name__):
				self.assert_cancel_restores_document(controller, module)

	def assert_cancel_restores_document(self, controller, module):
		sequence = Mock()
		row = frappe._dict(item="yarn", name="persisted-row", stock_qty=5, stock_uom="Kg")
		doc = SimpleNamespace(
			doctype="receipt",
			name="receipt",
			flags=frappe._dict(),
			items=[],
			posting_date="2099-01-01",
			posting_time="23:59:59",
			warehouse="main",
			from_warehouse="main",
			to_warehouse="supplier",
			against_purchase_order=0,
			is_return=1,
			lock_sources=sequence.sources,
			get_return_source=Mock(),
			validate_cancellable_delivery_challans=Mock(),
		)

		def reload_document():
			self.assertTrue(doc.flags.for_update)
			doc.items = [row]
			doc.posting_date, doc.posting_time = "2026-01-01", "09:00:00"

		doc.reload = sequence.reload
		doc.reload.side_effect = reload_document
		doc.get_stock_entries = lambda: controller.get_stock_entries(doc)
		self.database.get_value.return_value = None
		with (
			patch(f"{module}.validate_stock_dimensions"),
			patch(f"{module}.validate_backdated_cancel", sequence.policy),
		):
			controller.before_cancel(doc)
		self.assertEqual([entry[0] for entry in sequence.mock_calls], ["sources", "reload", "policy"])
		self.assertEqual(doc.docstatus, 2)
		entries = doc.get_stock_entries()
		self.assertTrue(entries)
		self.assertEqual({entry["voucher_detail_no"] for entry in entries}, {"persisted-row"})
		self.assertEqual({entry["posting_date"] for entry in entries}, {"2026-01-01"})
		self.assertEqual({entry["posting_time"] for entry in entries}, {"09:00:00"})

	def test_return_locks_current_and_persisted_sources_before_frappe(self):
		doc = object.__new__(MGKDeliveryChallan)
		doc.__dict__.update(doctype="MGK Delivery Challan", name="C-return", return_against="B-current")
		previous = SimpleNamespace(return_against="A-persisted")
		sequence = Mock()
		with (
			patch.object(doc, "is_new", return_value=False),
			patch(f"{DC}.frappe.get_doc", return_value=previous),
			patch.object(Document, "load_doc_before_save", sequence.frappe),
			patch(f"{LOCKING}.frappe.db.sql", sequence.lock),
		):
			doc.load_doc_before_save(raise_exception=True)
		self.assertEqual(
			[entry.args[1][0] for entry in sequence.mock_calls[:-1]],
			[
				"A-persisted",
				"B-current",
				"C-return",
			],
		)
		self.assertEqual(sequence.mock_calls[-1], call.frappe(raise_exception=True))

	def test_zero_value_close_keeps_links_without_adjustment(self):
		self.database.count.return_value = 1
		for difference in (0, 0.00001, -0.00001):
			with self.subTest(difference=difference), patch(f"{CLOSE}.register_production_links") as links:
				with patch(f"{CLOSE}.create_adjustment", return_value=None):
					MGKDeliveryChallanClose.create_valuation(self.doc, [{"difference": difference}], ["link"])
				links.assert_called_once_with(self.doc.doctype, self.doc.name, ["link"])
				self.assertIsNone(self.doc.stock_valuation_adjustment)

	def test_nonzero_close_rejects_missing_adjustment(self):
		self.database.count.return_value = 1
		with (
			patch(f"{CLOSE}.register_production_links"),
			patch(f"{CLOSE}.create_adjustment", return_value=None),
		):
			with self.assertRaisesRegex(frappe.ValidationError, "did not create"):
				MGKDeliveryChallanClose.create_valuation(self.doc, [{"difference": 0.000011}], ["link"])

	def test_zero_value_close_still_verifies_links(self):
		self.database.count.return_value = 0
		with patch(f"{CLOSE}.register_production_links"), patch(f"{CLOSE}.create_adjustment") as create:
			with self.assertRaisesRegex(frappe.ValidationError, "Incomplete production"):
				MGKDeliveryChallanClose.create_valuation(self.doc, [{"difference": 0}], ["link"])
			create.assert_not_called()

	def test_zero_value_close_has_no_adjustment_failure_blocker(self):
		close = SimpleNamespace(stock_valuation_adjustment=None, outputs=[], items=[])
		self.assertEqual(get_adjustment_blockers(close), [])
		self.database.get_value.assert_not_called()

	def test_pi_setting_off_rejects_even_zero_difference(self):
		with (
			patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=False),
			patch(f"{REVALUATION}.build_invoice_allocations", return_value=[{"difference": 0}]),
			patch(f"{REVALUATION}.create_adjustment") as create,
		):
			with self.assertRaisesRegex(frappe.ValidationError, "Enable Apply Stock Adjustment"):
				create_invoice_adjustment(self.doc)
			create.assert_not_called()

	def test_pi_reversal_does_not_require_adjustment_setting(self):
		doc = SimpleNamespace(
			doctype="MGK Purchase Invoice",
			name="invoice",
			lock_sources=Mock(),
			get_doc_before_save=Mock(return_value=Mock(as_dict=Mock(return_value={}))),
			meta=SimpleNamespace(fields=[]),
			update=Mock(),
			sync_grn_links=Mock(),
		)
		with (
			patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=False),
			patch(f"{INVOICE}.validate_stock_dimensions"),
			patch(f"{INVOICE}.validate_reversal_allowed"),
			patch(f"{INVOICE}.create_reversal") as reverse,
		):
			MGKPurchaseInvoice.before_cancel(doc)
			MGKPurchaseInvoice.on_cancel(doc)
		reverse.assert_called_once_with(doc.doctype, doc.name)
		doc.sync_grn_links.assert_called_once_with([])

	def test_grn_link_validation_checks_removals_and_current_links(self):
		doc = object.__new__(MGKGoodsReceivedNote)
		doc.__dict__.update(
			delivery_challans=[frappe._dict(delivery_challan="new")],
			against_purchase_order=0,
			supplier="supplier",
		)
		previous = SimpleNamespace(linked_delivery_challans=["old"])
		removed, current = Mock(), Mock(docstatus=1, is_return=0, to_location="supplier")
		with (
			patch.object(doc, "get_doc_before_save", return_value=previous),
			patch(f"{GRN}.frappe.get_doc", side_effect=[removed, current]),
			patch(f"{GRN}.frappe.has_permission"),
			patch(f"{GRN}.locking.lock_documents") as locks,
		):
			doc.validate_delivery_challan_links()
		locks.assert_called_once_with({"MGK Delivery Challan": ["new", "old"]})
		removed.check_permission.assert_called_once_with("read")
		removed.validate_open.assert_called_once_with("remove a GRN link")
		current.validate_open.assert_called_once_with("link")

	def test_transfer_comparison_and_pair_validation_remain_independent(self):
		outgoing = frappe._dict(
			name="out",
			item="yarn",
			warehouse="main",
			qty=-5,
			voucher_detail_no="row",
			paired_stock_ledger_entry="in",
		)
		incoming = frappe._dict(
			**{
				**outgoing,
				"name": "in",
				"warehouse": "supplier",
				"qty": 5,
				"paired_stock_ledger_entry": "out",
			}
		)
		with patch(f"{LEDGER}.get_voucher_sles", return_value=[outgoing, incoming]):
			assert_transfer_pairs("DC", "dc", expected_entries=[incoming, outgoing])
			with self.assertRaisesRegex(frappe.ValidationError, "do not match"):
				assert_transfer_pairs("DC", "dc", expected_entries=[outgoing])
			incoming.paired_stock_ledger_entry = "missing"
			with self.assertRaisesRegex(frappe.ValidationError, "Incomplete stock transfer pair"):
				assert_transfer_pairs("DC", "dc")
