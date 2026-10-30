from collections import defaultdict
from unittest import TestCase
from unittest.mock import Mock, PropertyMock, call, patch

import frappe
from frappe.model.document import Document

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import MGKDeliveryChallan
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import MGKPurchaseOrder
from mgk_yrp.purchase.receipt import PurchaseReceipt
from mgk_yrp.stock import transit
from mgk_yrp.tests.test_item_editor import EditorDocument, make_row, validation_error

TRANSIT = transit.__name__
CHALLAN = MGKDeliveryChallan.__module__
ORDER = MGKPurchaseOrder.__module__


class TestTransitReturnsUnit(TestCase):
	def setUp(self):
		self.database = Mock()
		self.database.get_single_value.return_value = "Transit"
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", side_effect=validation_error))
		self.enterContext(patch("frappe.get_system_settings", return_value="Banker's Rounding"))
		for module in (TRANSIT, CHALLAN, ORDER, PurchaseReceipt.__module__):
			self.enterContext(patch(f"{module}._", side_effect=lambda message: message))
		self.transferred = defaultdict(float)
		self.enterContext(patch(f"{TRANSIT}.get_transferred_quantities", return_value=self.transferred))
		self.row = make_row(name="source-row", qty=10, stock_qty=500, transferred_qty=0, returned_qty=0)
		self.row.db_set = lambda field, value, **kwargs: self.row.set(field, value)
		self.returned = defaultdict(float)
		self.source = EditorDocument(
			doctype="MGK Delivery Challan", name="Source", docstatus=1, is_internal_transfer=1,
			from_location="Origin", from_warehouse="Origin WH", to_location="Destination",
			to_warehouse="Receiving", transit_warehouse="Transit", process_name="Knitting",
			items=[self.row], get_returned_stock_qty=lambda: self.returned,
			validate_open=Mock(), db_set=Mock(), notify_update=Mock(),
		)

	def test_u3_pending_converts_submitted_returns_and_ignores_cached_counters(self):
		self.returned[self.row.name] = 200
		self.transferred[self.row.name] = 3
		self.assertEqual(transit.get_pending_quantities(self.source), {self.row.name: 3})
		with self.assertRaisesRegex(frappe.ValidationError, "exceeds the pending"):
			transit.validate_pending_quantities(self.source, {self.row.name: 4})
		transit.validate_pending_quantities(self.source, {self.row.name: 3})

	def test_u3_return_allowance_aggregates_rows_and_counts_completions(self):
		self.transferred[self.row.name] = 6
		self.returned[self.row.name] = 50
		returned = EditorDocument(items=[make_row(against_dc_item=self.row.name, qty=2) for _ in range(2)])
		with self.assertRaisesRegex(frappe.ValidationError, "Return exceeds"):
			MGKDeliveryChallan.validate_return_allowance(returned, self.source)
		returned.items.pop()
		MGKDeliveryChallan.validate_return_allowance(returned, self.source)

	def test_u3_noninternal_return_cap_uses_existing_return_totals(self):
		self.source.is_internal_transfer = 0
		self.transferred[self.row.name] = 10
		self.returned[self.row.name] = 100
		self.assertEqual(transit.get_pending_quantities(self.source), {self.row.name: 8})
		transit.get_transferred_quantities.assert_not_called()

	def test_u4_u5_status_recomputed_for_returns_completions_and_cancellations(self):
		for returned, transferred, expected in (
			(0, 0, "In Transit"), (200, 0, "Partly Transferred"), (200, 6, "Transferred"),
			(500, 0, "Returned"), (200, 0, "Partly Transferred"), (0, 0, "In Transit"),
		):
			self.returned[self.row.name] = returned
			self.transferred[self.row.name] = transferred
			with self.subTest(returned=returned, transferred=transferred):
				transit.update_transfer_status(self.source)
				self.source.db_set.assert_called_with("transfer_status", expected, update_modified=False)
				self.assertEqual(self.row.transferred_qty, transferred)

	def test_u4_return_updates_existing_counter_and_transit_status(self):
		self.returned[self.row.name] = 200
		MGKDeliveryChallan.update_returned_qty(self.source)
		self.assertEqual(self.row.returned_qty, 200)
		self.source.db_set.assert_called_once_with("transfer_status", "Partly Transferred", update_modified=False)

	def test_u2_only_internal_return_can_use_stored_transit_as_source(self):
		returned = EditorDocument(is_return=1, return_against=self.source.name, from_warehouse="Transit")
		with patch(f"{TRANSIT}.get_source", return_value=self.source):
			transit.validate_route_warehouses(returned)
			self.source.is_internal_transfer = 0
			with self.assertRaisesRegex(frappe.ValidationError, "Transit Warehouse"):
				transit.validate_route_warehouses(returned)
		self.source.is_internal_transfer = 1
		self.source.transit_warehouse = "Old Transit"
		with patch(f"{TRANSIT}.get_source", return_value=self.source):
			with self.assertRaisesRegex(frappe.ValidationError, "Transit Warehouse"):
				transit.validate_route_warehouses(returned)

	def test_u2_return_header_matches_stored_transit_even_if_setting_changes(self):
		self.source.transit_warehouse = "Old Transit"
		returned = EditorDocument(
			from_location="Destination", from_warehouse="Old Transit", to_location="Origin",
			to_warehouse="Origin WH", process_name="Knitting",
		)
		MGKDeliveryChallan.validate_return_header(returned, self.source)
		returned.from_warehouse = "Receiving"
		with self.assertRaisesRegex(frappe.ValidationError, "Return from_warehouse"):
			MGKDeliveryChallan.validate_return_header(returned, self.source)

	def test_u1_return_source_keeps_noninternal_open_guard(self):
		transit.validate_return_source(self.source)
		self.source.validate_open.assert_not_called()
		self.source.is_internal_transfer = 0
		transit.validate_return_source(self.source)
		self.source.validate_open.assert_called_once_with("return")

	def test_u3_return_locks_source_and_return_in_one_ordered_call(self):
		returned = EditorDocument(
			return_against="MGK-DC-1", name="MGK-DC-2", purchase_order=None, goods_received_note=None,
			items=[], docstatus=0,
			get_doc_before_save=lambda: None,
		)
		with patch(f"{CHALLAN}.lock_documents") as lock:
			MGKDeliveryChallan.lock_sources(returned)
		lock.assert_called_once_with({"MGK Delivery Challan": ["MGK-DC-1", None, "MGK-DC-2"]})

	def test_u6_company_supplier_block_runs_before_other_po_validation(self):
		supplier = Mock(is_company_location="1")
		order = object.__new__(MGKPurchaseOrder)
		order.supplier = "Company Location"
		with patch(f"{ORDER}.frappe.get_doc", return_value=supplier) as read:
			with self.assertRaises(frappe.ValidationError) as error:
				order.validate()
		self.assertEqual(
			str(error.exception),
			"Company Location is a company location; use a Delivery Challan to move stock between company locations.",
		)
		read.assert_called_once_with("Supplier", order.supplier)
		supplier.check_permission.assert_called_once_with("read")
		self.database.get_value.assert_not_called()

	def test_po_supplier_permission_precedes_company_classification(self):
		supplier = Mock()
		classification = PropertyMock(return_value=1)
		type(supplier).is_company_location = classification
		supplier.check_permission.side_effect = frappe.PermissionError
		self.database.get_value.return_value = 1
		order = object.__new__(MGKPurchaseOrder)
		order.supplier = "Restricted Supplier"
		with patch(f"{ORDER}.frappe.get_doc", return_value=supplier) as read:
			with self.assertRaises(frappe.PermissionError):
				order.validate()
		read.assert_called_once_with("Supplier", order.supplier)
		supplier.check_permission.assert_called_once_with("read")
		classification.assert_not_called()
		self.database.get_value.assert_not_called()

	def test_po_party_details_reuse_checked_supplier_for_classification(self):
		supplier = Mock(is_company_location=0)
		order = object.__new__(MGKPurchaseOrder)
		order.__dict__.update(supplier="Vendor", supplier_address=None, contact_person=None)
		with (
			patch(f"{ORDER}.frappe.get_doc", return_value=supplier) as read,
			patch.object(order, "has_supplier_link", return_value=True),
		):
			order.set_party_details()
		read.assert_called_once_with("Supplier", order.supplier)
		supplier.check_permission.assert_called_once_with("read")
		self.database.get_value.assert_not_called()

	def test_u6_submitted_save_and_cancel_do_not_call_validate(self):
		for action in ("update_after_submit", "cancel"):
			order = EditorDocument(
				_action=action, flags=frappe._dict(), reset_seen=Mock(), run_method=Mock(), set_title_field=Mock(),
			)
			Document.run_before_save_methods(order)
			self.assertNotIn(call("validate"), order.run_method.call_args_list)

	def test_u7_legacy_internal_direct_receipt_fails_before_writes(self):
		order = EditorDocument(
			doctype="MGK Purchase Order", name="Legacy", docstatus=1, flags=frappe._dict(),
			supplier="Company", deliver_to_supplier=1, receipt_location={"location": "Destination"},
			items=[make_row(pending_qty=10)], reload=Mock(), check_permission=Mock(),
		)
		with (
			patch("frappe.has_permission"), patch("mgk_yrp.purchase.receipt.lock_documents"),
			patch("mgk_yrp.purchase.receipt.is_internal_route", return_value=True),
			patch("mgk_yrp.purchase.receipt.lock_stock_buckets") as buckets,
		):
			with self.assertRaisesRegex(frappe.ValidationError, "internal transfer; cannot Deliver to Supplier"):
				PurchaseReceipt(order).submit()
		buckets.assert_not_called()
		self.database.savepoint.assert_not_called()
		self.database.commit.assert_not_called()
