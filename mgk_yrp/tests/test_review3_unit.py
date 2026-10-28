from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call, patch

import frappe
from frappe.model.document import Document

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan_close.mgk_delivery_challan_close import (
	MGKDeliveryChallanClose,
)
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice import (
	MGKPurchaseInvoice,
	get_billable_grn,
)
from mgk_yrp.tests.test_review_unit import CLOSE, GRN, INVOICE, throw_validation


class TestReview3Unit(TestCase):
	def setUp(self):
		self.database = Mock()
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", throw_validation))
		for module in (GRN, INVOICE):
			self.enterContext(patch(f"{module}._", side_effect=lambda text: text))

	def test_c73_c80_grn_update_after_submit_rejects_clear_and_replacement(self):
		doc = SimpleNamespace(get_doc_before_save=lambda: SimpleNamespace(purchase_invoice="PI-1"))
		for value in (None, "PI-2"):
			doc.purchase_invoice = value
			with (
				self.subTest(value=value),
				self.assertRaisesRegex(frappe.ValidationError, "maintained by billing"),
			):
				MGKGoodsReceivedNote.before_update_after_submit(doc)
		doc.purchase_invoice = "PI-1"
		MGKGoodsReceivedNote.before_update_after_submit(doc)

	def test_c73_c80_invoice_checks_active_children_under_grn_lock(self):
		sequence = Mock()
		receipt = Mock(docstatus=1, purchase_invoice=None)
		receipt.name = "GRN"
		sequence.receipt.return_value = receipt
		self.database.sql = sequence.references
		sequence.references.return_value = ["PI-existing"]
		with patch(f"{INVOICE}.frappe.get_doc", sequence.receipt):
			with self.assertRaisesRegex(frappe.ValidationError, "PI-existing"):
				get_billable_grn("GRN", invoice="PI-new")
		self.assertEqual(
			sequence.mock_calls[0], call.receipt("MGK Goods Received Note", "GRN", for_update=True)
		)
		query = sequence.references.call_args
		self.assertIn("invoice.docstatus < 2", query.args[0])
		self.assertIn("invoice.name != %(invoice)s", query.args[0])
		self.assertTrue(query.args[0].endswith("FOR UPDATE"))
		self.assertEqual(query.args[1], {"grn": "GRN", "invoice": "PI-new"})

	def test_c74_c80_pi_deletion_returns_explicit_retry_on_parent_contention(self):
		for error in (frappe.QueryTimeoutError, frappe.QueryDeadlockError):
			doc = SimpleNamespace(sync_grn_links=Mock(side_effect=error))
			with (
				self.subTest(error=error),
				self.assertRaisesRegex(frappe.QueryTimeoutError, "retry deleting"),
			):
				MGKPurchaseInvoice.on_trash(doc)
			doc.sync_grn_links.assert_called_once_with([], wait=False)
		self.database.set_value.assert_not_called()

	def test_close_submission_discovers_dependencies_before_frappe_parent_lock(self):
		doc = object.__new__(MGKDeliveryChallanClose)
		doc.__dict__.update(doctype="MGK Delivery Challan Close", name="upstream", docstatus=1)
		previous, sequence = SimpleNamespace(delivery_challan="old-challan"), Mock()
		with (
			patch.object(doc, "is_new", return_value=False),
			patch(f"{CLOSE}.frappe.get_doc", return_value=previous),
			patch(f"{CLOSE}.lock_close_submission", sequence.dependencies),
			patch.object(Document, "load_doc_before_save", sequence.frappe),
		):
			doc.load_doc_before_save(raise_exception=True)
		self.assertEqual(
			sequence.mock_calls,
			[call.dependencies(doc, "old-challan"), call.frappe(raise_exception=True)],
		)
