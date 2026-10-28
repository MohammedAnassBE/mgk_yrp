from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

import frappe
from frappe.api.v1 import delete_doc as delete_resource
from frappe.api.v2 import delete_doc as delete_resource_v2
from frappe.client import delete as delete_from_desk
from frappe.desk.reportview import delete_bulk

from mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice import MGKPurchaseInvoice
from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import make_purchase_invoice
from mgk_yrp.tests.test_stock_concurrency import worker_connection
from mgk_yrp.tests.valuation_fixtures import committed_stock_records


class TestInvoiceDeletionConcurrency(CloseTestCase):
	"""C74/C80: deletion owns PI while cancellation owns its GRN."""

	def setUp(self):
		self.enterContext(committed_stock_records())
		super().setUp()
		self.enterContext(patch("frappe.publish_realtime"))
		self.site, self.sites_path = frappe.local.site, frappe.local.sites_path

	def test_c74_c80_desk_delete_retries_without_deadlock(self):
		self.assert_deletion_retries(delete_from_desk)

	def test_c74_c80_bulk_delete_retries_without_deadlock(self):
		self.assert_deletion_retries(lambda doctype, name: delete_bulk(doctype, [name]))

	def test_c74_c80_rest_delete_retries_without_deadlock(self):
		self.assert_deletion_retries(delete_resource)

	def test_c74_c80_rest_v2_delete_retries_without_deadlock(self):
		self.assert_deletion_retries(delete_resource_v2)

	def assert_deletion_retries(self, delete):
		receipt = self.make_output([])
		invoice = make_purchase_invoice(
			against="Job Work", supplier=self.supplier, grns=[receipt], submit=False
		)
		frappe.db.commit()
		invoice_locked, sources_locked = Event(), Event()
		with ThreadPoolExecutor(max_workers=1) as pool:
			deletion = pool.submit(
				self.delete_while_cancelling, delete, invoice, invoice_locked, sources_locked
			)
			try:
				self.assertTrue(invoice_locked.wait(10), "Deletion did not lock the PI")
				receipt.load_doc_before_save()
				sources_locked.set()
				with self.assertRaisesRegex(
					frappe.ValidationError, f"Cancel Purchase Invoice {invoice.name}"
				):
					receipt.cancel()
			finally:
				sources_locked.set()
				frappe.db.rollback()
			self.assertIn("retry deleting", deletion.result(timeout=15))
		self.assertTrue(frappe.db.exists(invoice.doctype, invoice.name))
		self.assertEqual(receipt.reload().purchase_invoice, invoice.name)
		delete(invoice.doctype, invoice.name)
		self.assertFalse(frappe.db.exists(invoice.doctype, invoice.name))
		self.assertFalse(receipt.reload().purchase_invoice)
		receipt.cancel()
		self.assertEqual(receipt.docstatus, 2)

	def delete_while_cancelling(self, delete, invoice, invoice_locked, sources_locked):
		on_trash = MGKPurchaseInvoice.on_trash
		errors = []

		def wait_for_cancellation(document):
			invoice_locked.set()
			if not sources_locked.wait(10):
				raise AssertionError("Cancellation did not lock the GRN")
			try:
				on_trash(document)
			except frappe.QueryTimeoutError as error:
				errors.append(str(error))
				raise

		with worker_connection(self.site, self.sites_path):
			with patch.object(MGKPurchaseInvoice, "on_trash", wait_for_cancellation):
				try:
					delete(invoice.doctype, invoice.name)
				except frappe.QueryTimeoutError:
					pass
		return "\n".join(errors)
