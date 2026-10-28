from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, now_datetime, nowdate

from mgk_yrp.stock.backdating import (
	has_later_linked_movements,
	validate_backdated_cancel,
	validate_backdated_posting,
)
from mgk_yrp.stock.locking import lock_documents, lock_stock_buckets, lock_valuation_bucket

LOCKING = "mgk_yrp.stock.locking"
DC = "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan"


@contextmanager
def worker_connection(site, sites_path):
	frappe.init(site, sites_path=sites_path)
	frappe.connect()
	frappe.flags.in_test = True
	try:
		yield
	finally:
		frappe.db.rollback()
		frappe.destroy()


class TestStockConcurrency(IntegrationTestCase):
	"""Two real transactions; synthetic records isolate locking from valuation."""

	def setUp(self):
		super().setUp()
		self.site, self.sites_path = frappe.local.site, frappe.local.sites_path
		self.suffix = frappe.generate_hash(length=12)
		self.item, self.warehouse = f"race-item-{self.suffix}", f"race-warehouse-{self.suffix}"
		self.buckets = [(self.item, self.warehouse)]
		self.movement = f"race-sle-{self.suffix}"
		self.doc = SimpleNamespace(
			doctype="MGK Goods Received Note",
			name=f"race-grn-{self.suffix}",
			posting_date=add_days(nowdate(), -1),
			posting_time="09:00:00",
			get=lambda field: 1,
			get_stock_entries=lambda: [{"item": self.item, "warehouse": self.warehouse}],
		)
		self.addCleanup(self.remove_records)

	def remove_records(self):
		frappe.db.rollback()
		for doctype in (
			"YRP Stock Ledger Entry",
			"MGK Delivery Challan Item",
			"MGK Delivery Challan Close",
			"MGK Delivery Challan",
		):
			frappe.db.delete(doctype, {"name": ("like", f"%{self.suffix}")})
		frappe.db.delete("Version", {"docname": ("like", f"%{self.suffix}")})
		frappe.db.delete("Comment", {"reference_name": ("like", f"%{self.suffix}")})
		frappe.db.commit()

	def test_backdated_post_sees_transfer_committed_while_waiting_for_bucket(self):
		self.assert_current_read_after_bucket_wait(cancel=False)

	def test_backdated_cancel_sees_transfer_committed_while_waiting_for_bucket(self):
		self.assert_current_read_after_bucket_wait(cancel=True)

	def assert_current_read_after_bucket_wait(self, *, cancel):
		ready, waiting = Event(), Event()
		with ThreadPoolExecutor(max_workers=1) as pool:
			writer = pool.submit(self.commit_transfer_after_waiter, ready, waiting)
			try:
				self.assertTrue(ready.wait(10), "Writer did not acquire the bucket")
				self.assertFalse(has_later_linked_movements(self.buckets, self.doc.posting_date, ("", "")))
				with patch(f"{LOCKING}.lock_valuation_bucket", side_effect=self.observe_waiter(waiting)):
					with self.assertRaisesRegex(frappe.ValidationError, "later linked movements"):
						if cancel:
							validate_backdated_cancel(self.doc)
						else:
							validate_backdated_posting(self.doc, self.buckets)
			finally:
				waiting.set()
				frappe.db.rollback()
				writer.result(timeout=15)

	def observe_waiter(self, waiting):
		def lock(bucket):
			waiting.set()
			return lock_valuation_bucket(bucket)

		return lock

	def commit_transfer_after_waiter(self, ready, waiting):
		with worker_connection(self.site, self.sites_path):
			lock_stock_buckets(self.buckets)
			frappe.db.sql(
				"""INSERT INTO `tabYRP Stock Ledger Entry`
				(name, item, warehouse, qty, posting_datetime, voucher_type, voucher_no,
				is_cancelled, paired_stock_ledger_entry)
				VALUES (%s, %s, %s, -1, %s, 'MGK Delivery Challan', %s, 0, %s)""",
				(
					self.movement,
					self.item,
					self.warehouse,
					f"{self.doc.posting_date} 12:00:00",
					f"race-transfer-{self.suffix}",
					f"peer-{self.suffix}",
				),
			)
			ready.set()
			if not waiting.wait(10):
				raise AssertionError("Backdating validation did not request the bucket")
			frappe.db.commit()

	def test_return_cancel_waits_for_close_before_locking_return(self):
		source, returned, close_name = self.insert_challans()
		close = frappe.get_doc("MGK Delivery Challan Close", close_name)
		close.flags.ignore_mandatory = True
		close.load_doc_before_save()
		waiting = Event()

		def observe_source_lock(documents):
			waiting.set()
			return lock_documents(documents)

		with ThreadPoolExecutor(max_workers=1) as pool:
			with patch(f"{DC}.lock_documents", side_effect=observe_source_lock):
				cancellation = pool.submit(self.cancel_return, returned)
				try:
					self.assertTrue(waiting.wait(10), "Return cancellation did not request source locks")
					close.submit()
					frappe.db.commit()
				finally:
					frappe.db.rollback()
				with self.assertRaisesRegex(frappe.ValidationError, "Closed"):
					cancellation.result(timeout=15)
		self.assertEqual(frappe.db.get_value("MGK Delivery Challan", source, "close_status"), "Closed")
		self.assertEqual(frappe.db.get_value("MGK Delivery Challan", returned, "docstatus"), 1)

	def cancel_return(self, name):
		with worker_connection(self.site, self.sites_path):
			frappe.get_doc("MGK Delivery Challan", name).cancel()
			frappe.db.commit()

	def insert_challans(self):
		source, returned, close = (f"race-{index}-{self.suffix}" for index in range(3))
		posting = now_datetime()
		for name, status, is_return, return_against in (
			(source, "Open", 0, None),
			(returned, "", 1, source),
		):
			frappe.db.sql(
				"""INSERT INTO `tabMGK Delivery Challan`
				(name, modified, creation, owner, modified_by, docstatus, posting_date, posting_time,
				close_status, is_return, return_against)
				VALUES (%s, %s, %s, 'Administrator', 'Administrator', 1, %s, %s, %s, %s, %s)""",
				(name, posting, posting, posting.date(), posting.time(), status, is_return, return_against),
			)
		frappe.db.sql(
			"""INSERT INTO `tabMGK Delivery Challan Item`
			(name, parent, parenttype, parentfield, idx, docstatus, qty, stock_qty, conversion_factor)
			VALUES (%s, %s, 'MGK Delivery Challan', 'items', 1, 1, 1, 1, 1)""",
			(f"race-row-{self.suffix}", returned),
		)
		frappe.db.sql(
			"""INSERT INTO `tabMGK Delivery Challan Close`
			(name, modified, creation, owner, modified_by, docstatus, delivery_challan)
			VALUES (%s, %s, %s, 'Administrator', 'Administrator', 0, %s)""",
			(close, posting, posting, source),
		)
		frappe.db.commit()
		return source, returned, close
