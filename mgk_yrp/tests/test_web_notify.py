from unittest.mock import patch

import frappe
from frappe.utils import get_datetime

from mgk_yrp.job_work.reopen import finish_reopen
from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import (
	close_dc,
	make_po_grn,
	make_purchase_invoice,
	make_purchase_order,
	make_return,
	run_adjustments,
)
from mgk_yrp.web.notify import VALUATION_METHOD, valuation_job_finished, valuation_updated


class TestWebNotify(CloseTestCase):
	def assert_stock_notified(self, publish):
		publish.assert_any_call(
			"list_update", {"doctype": "YRP Stock Ledger Entry"},
			doctype="YRP Stock Ledger Entry", after_commit=True,
		)

	def assert_notified(self, publish, doctype, name):
		for event in ("doc_update", "list_update"):
			matches = [
				call
				for call in publish.call_args_list
				if call.args[0] == event
				and call.args[1].get("doctype") == doctype
				and call.args[1].get("name") == name
			]
			self.assertTrue(matches, f"Missing {event} for {doctype} {name}")
			self.assertTrue(all(call.kwargs.get("after_commit") for call in matches))

	def test_grn_submit_notifies_po_with_unchanged_modified(self):
		order = make_purchase_order(
			supplier=self.purchase_supplier, warehouse=self.main, items=[{"item": self.raw_item, "qty": 10, "rate": 100}]
		)
		modified = order.modified
		with patch("frappe.publish_realtime") as publish:
			make_po_grn(order)
		self.assert_notified(publish, order.doctype, order.name)
		self.assertEqual(get_datetime(order.reload().modified), get_datetime(modified))

	def test_invoice_submit_and_cancel_notify_grn(self):
		receipt = self.make_input()
		with (
			patch("mgk_yrp.purchase.revaluation.is_stock_adjustment_enabled", return_value=True),
			patch("frappe.publish_realtime") as publish,
		):
			invoice = make_purchase_invoice(supplier=self.purchase_supplier, against="Purchase Order", grns=[receipt])
			self.assert_notified(publish, receipt.doctype, receipt.name)
			run_adjustments(invoice.doctype, invoice.name)
			publish.reset_mock()
			invoice.reload().cancel()
			self.assert_notified(publish, receipt.doctype, receipt.name)

	def test_close_submit_reopen_and_completion_notify_dc_and_close(self):
		challan, _receipt = self.make_cycle()
		with patch("frappe.publish_realtime") as publish:
			close = close_dc(challan)
			self.assert_notified(publish, challan.doctype, challan.name)
			run_adjustments(close.doctype, close.name)
			publish.reset_mock()
			close.reload().cancel()
			self.assert_notified(publish, challan.doctype, challan.name)
			run_adjustments(close.doctype, close.name)
			publish.reset_mock()
			self.assertTrue(finish_reopen(close.name))
			self.assert_notified(publish, challan.doctype, challan.name)
			self.assert_notified(publish, close.doctype, close.name)

	def test_return_notifies_original_dc(self):
		self.make_input()
		challan = self.make_challan()
		with patch("frappe.publish_realtime") as publish:
			make_return(challan, {challan.items[0].name: 1})
		self.assert_notified(publish, challan.doctype, challan.name)

	def test_valuation_final_hook_and_worker_completion_notify_invoice(self):
		receipt = self.make_input()
		with patch("mgk_yrp.purchase.revaluation.is_stock_adjustment_enabled", return_value=True):
			invoice = make_purchase_invoice(
				supplier=self.purchase_supplier,
				against="Purchase Order",
				grns=[receipt],
				rates={receipt.items[0].name: 110},
			)
		run_adjustments(invoice.doctype, invoice.name)
		name = frappe.db.get_value(
			"YRP Stock Valuation Adjustment", {"source_doctype": invoice.doctype, "source_name": invoice.name}
		)
		adjustment = frappe.get_doc("YRP Stock Valuation Adjustment", name)
		with patch("frappe.publish_realtime") as publish:
			valuation_updated(adjustment)
			self.assert_stock_notified(publish)
			self.assert_notified(publish, invoice.doctype, invoice.name)
			publish.reset_mock()
			with patch.object(frappe.db, "commit") as commit:
				valuation_job_finished(VALUATION_METHOD, {"adjustment": name})
			commit.assert_called_once()
			self.assert_notified(publish, invoice.doctype, invoice.name)
			publish.reset_mock()
			invoice.reload().cancel()
			run_adjustments(invoice.doctype, invoice.name)
			reversal = frappe.get_doc("YRP Stock Valuation Adjustment", {"reversal_of": name})
			publish.reset_mock()
			with patch.object(frappe.db, "commit"):
				valuation_job_finished(VALUATION_METHOD, {"adjustment": reversal.name})
			self.assert_stock_notified(publish)
			publish.reset_mock()
			adjustment.status = "Applying"
			valuation_updated(adjustment)
			publish.assert_not_called()
