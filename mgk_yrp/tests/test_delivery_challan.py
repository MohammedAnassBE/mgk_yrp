from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, flt, get_time, getdate, nowdate
from yrp.stock.stock_ledger import NegativeStockError
from yrp.stock.utils import get_stock_balance
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	create_adjustment,
)

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import make_return_delivery_challan
from mgk_yrp.stock.ledger import assert_transfer_pairs, get_voucher_sles
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.tests.fixtures import (
	make_delivery_challan,
	make_item,
	make_po_grn,
	make_process,
	make_purchase_order,
	make_return,
	make_supplier,
	make_uom,
	make_warehouse,
)
from mgk_yrp.tests.valuation_fixtures import process_adjustment

CONTROLLER = "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan"
ADJUSTMENT = "yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment"


class TestDeliveryChallan(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.enterContext(patch("frappe.enqueue"))
		self.from_supplier = make_supplier(is_company_location=1)
		self.to_supplier = make_supplier()
		self.main = make_warehouse(supplier=self.from_supplier)
		self.destination = make_warehouse(supplier=self.to_supplier)
		self.item = make_item(stock_uom=make_uom("Kg"))
		self.process_name = make_process()

	def make_receipt(self, *, item=None, quantity=50, rate=100, submit=True):
		order = make_purchase_order(
			supplier=self.from_supplier,
			warehouse=self.main,
			items=[{"item": item or self.item, "qty": quantity, "rate": rate}],
		)
		return make_po_grn(order, submit=submit)

	def make_challan(self, *, quantity=50, rate=0, item=None, submit=True, **header):
		return make_delivery_challan(
			from_warehouse=self.main,
			to_supplier=self.to_supplier,
			to_warehouse=self.destination,
			process_name=self.process_name,
			items=[{"item": item or self.item, "qty": quantity, "rate": rate}],
			submit=submit,
			**header,
		)

	def assert_pair(self, challan, *, quantity, rate, source, destination):
		entries = get_voucher_sles(challan.doctype, challan.name)
		self.assertEqual(len(entries), 2)
		outgoing = next(entry for entry in entries if entry.qty < 0)
		incoming = next(entry for entry in entries if entry.qty > 0)
		self.assertEqual(outgoing.paired_stock_ledger_entry, incoming.name)
		self.assertEqual(incoming.paired_stock_ledger_entry, outgoing.name)
		self.assertEqual((outgoing.warehouse, incoming.warehouse), (source, destination))
		self.assertEqual((outgoing.qty, incoming.qty), (-quantity, quantity))
		self.assertEqual(incoming.rate, rate)
		self.assertEqual(
			(outgoing.stock_value_difference, incoming.stock_value_difference),
			(-quantity * rate, quantity * rate),
		)
		return outgoing, incoming

	def test_dc_requires_process_and_locations(self):
		for fieldname in ("process_name", "from_location", "to_location", "from_warehouse"):
			with self.subTest(fieldname=fieldname):
				challan = self.make_challan(submit=False)
				challan.set(fieldname, None)
				with self.assertRaises(frappe.MandatoryError):
					challan.save()
		challan = self.make_challan(submit=False)
		challan.to_location = make_supplier()
		challan.to_warehouse = None
		with self.assertRaises(frappe.MandatoryError):
			challan.save()

	def test_dc_defaults_supplier_warehouse(self):
		challan = make_delivery_challan(
			from_warehouse=self.main,
			to_supplier=self.to_supplier,
			to_warehouse=None,
			items=[{"item": self.item, "qty": 1}],
			process_name=self.process_name,
			submit=False,
		)
		self.assertEqual(challan.to_warehouse, self.destination)
		explicit = make_warehouse(supplier=self.to_supplier)
		challan.to_warehouse = explicit
		challan.save()
		self.assertEqual(challan.to_warehouse, explicit)
		challan.to_warehouse = None
		with self.assertRaises(frappe.MandatoryError):
			challan.save()

	def test_dc_posts_paired_transfer(self):
		self.make_receipt()
		challan = self.make_challan(dc_number="External DC 123", vehicle_number="TN 01 AB 1234")
		self.assert_pair(challan, quantity=50, rate=100, source=self.main, destination=self.destination)
		self.assertEqual(get_stock_balance(self.item, self.main), 0)
		self.assertEqual(get_stock_balance(self.item, self.destination), 50)
		self.assertTrue(challan.is_open)
		self.assertTrue(challan.name.startswith("MGK-DC-"))
		self.assertEqual(challan.dc_number, "External DC 123")
		self.assertEqual(challan.vehicle_number, "TN 01 AB 1234")

	def test_declared_rate_does_not_affect_valuation(self):
		self.make_receipt()
		challan = self.make_challan(rate=999)
		self.assert_pair(challan, quantity=50, rate=100, source=self.main, destination=self.destination)
		self.assertEqual(challan.items[0].rate, 999)
		self.assertEqual(challan.total_declared_value, 49950)
		self.assertEqual(challan.total_qty, 50)
		self.assertEqual(challan.items[0].amount, 49950)

	def test_dc_rejects_invalid_quantity_and_declared_rate(self):
		for values in ({"qty": 0}, {"qty": -1}, {"rate": -1}):
			with self.subTest(values=values):
				challan = self.make_challan(submit=False)
				challan.items[0].update(values)
				with self.assertRaises(frappe.ValidationError):
					challan.save()

	def test_dc_insufficient_stock_throws(self):
		self.make_receipt()
		challan = self.make_challan(quantity=51, submit=False)
		with patch("yrp.stock.stock_ledger._item_allows_negative_stock", return_value=False):
			with self.assertRaises(NegativeStockError):
				challan.submit()

	def test_dc_same_warehouse_rejected(self):
		challan = self.make_challan(submit=False)
		challan.to_warehouse = self.main
		with self.assertRaisesRegex(frappe.ValidationError, "must be different"):
			challan.save()

	def test_return_reduces_balance_and_posts_pair(self):
		self.make_receipt()
		challan = self.make_challan()
		returned = make_return(challan, {challan.items[0].name: 10})
		self.assert_pair(returned, quantity=10, rate=100, source=self.destination, destination=self.main)
		self.assertEqual(returned.return_against, challan.name)
		self.assertEqual(
			(returned.from_location, returned.to_location), (self.to_supplier, self.from_supplier)
		)
		self.assertEqual(returned.process_name, challan.process_name)
		self.assertEqual(challan.reload().items[0].returned_qty, 10)
		self.assertEqual(get_stock_balance(self.item, self.destination), 40)
		self.assertEqual(get_stock_balance(self.item, self.main), 10)
		mapped = make_return_delivery_challan(challan.name)
		self.assertEqual(mapped.items[0].qty, 40)
		self.assertEqual(mapped.items[0].against_dc_item, challan.items[0].name)
		returned.cancel()
		self.assertEqual(challan.reload().items[0].returned_qty, 0)
		self.assertFalse(get_voucher_sles(returned.doctype, returned.name))
		self.assertEqual(get_stock_balance(self.item, self.destination), 50)

	def test_return_cannot_exceed_remaining(self):
		self.make_receipt()
		challan = self.make_challan()
		make_return(challan, {challan.items[0].name: 10})
		with self.assertRaisesRegex(frappe.ValidationError, "remaining delivered quantity"):
			make_return(challan, {challan.items[0].name: 41})
		first = make_return(challan, {challan.items[0].name: 30}, submit=False)
		second = make_return(challan, {challan.items[0].name: 30}, submit=False)
		first.submit()
		with patch(f"{CONTROLLER}.lock_documents", wraps=lock_documents) as locks:
			with self.assertRaisesRegex(frappe.ValidationError, "remaining delivered quantity"):
				second.submit()
		self.assertEqual(
			locks.call_args.args[0], {"MGK Delivery Challan": [challan.name, challan.name, second.name]}
		)
		self.assertFalse(get_voucher_sles(second.doctype, second.name))
		self.assertEqual(challan.reload().items[0].returned_qty, 40)

	def test_return_cap_sums_duplicate_rows_and_ignores_cached_balance(self):
		self.make_receipt()
		challan = self.make_challan()
		make_return(challan, {challan.items[0].name: 10})
		challan.items[0].db_set("returned_qty", 0)
		returned = make_return_delivery_challan(challan.name)
		returned.items[0].qty = 21
		duplicate = returned.items[0].as_dict()
		duplicate.pop("name", None)
		returned.append("items", duplicate)
		returned.insert(ignore_permissions=True)
		with self.assertRaisesRegex(frappe.ValidationError, "remaining delivered quantity"):
			returned.submit()

	def test_return_uom_snapshot_mismatch_throws(self):
		self.make_receipt()
		challan = self.make_challan()
		for fieldname, value in (("uom", make_uom("Nos")), ("stock_uom", "Nos"), ("conversion_factor", 2)):
			with self.subTest(fieldname=fieldname):
				returned = make_return_delivery_challan(challan.name)
				returned.items[0].set(fieldname, value)
				with self.assertRaisesRegex(frappe.ValidationError, "different"):
					returned.insert(ignore_permissions=True)
		returned = make_return(challan, {challan.items[0].name: 10}, submit=False)
		returned.items[0].conversion_factor = 2
		with self.assertRaisesRegex(frappe.ValidationError, "different"):
			returned.submit()

	def test_return_uses_stock_uom_balance_and_keeps_source_snapshot(self):
		item = make_item(stock_uom=make_uom("Kg"), purchase_uom=make_uom("Bag"), conversion_factor=50)
		self.make_receipt(item=item, quantity=2, rate=5000)
		challan = self.make_challan(item=item, quantity=2)
		returned = make_return(challan, {challan.items[0].name: 0.5}, submit=False)
		parent = frappe.db.get_value("Item", item, "variant_of")
		frappe.db.set_value(
			"UOM Conversion Detail", {"parent": parent, "uom": "Bag"}, "conversion_factor", 60
		)
		frappe.clear_document_cache("Item", parent)
		returned.submit()
		self.assertEqual(returned.items[0].conversion_factor, 50)
		self.assertEqual(returned.items[0].stock_qty, 25)
		self.assertEqual(challan.reload().items[0].returned_qty, 25)
		self.assertEqual(make_return_delivery_challan(challan.name).items[0].qty, 1.5)

	def test_return_blocked_when_dc_closed(self):
		self.make_receipt()
		challan = self.make_challan()
		returned = make_return(challan, {challan.items[0].name: 10}, submit=False)
		for status in ("Closed", "Reopening"):
			with self.subTest(status=status):
				challan.db_set("close_status", status)
				with self.assertRaisesRegex(frappe.ValidationError, status):
					make_return_delivery_challan(challan.name)
				with self.assertRaisesRegex(frappe.ValidationError, status):
					returned.reload().submit()

	def test_return_cancel_blocked_when_dc_closed(self):
		self.make_receipt()
		challan = self.make_challan()
		returned = make_return(challan, {challan.items[0].name: 10})
		challan.db_set("close_status", "Reopening")
		with self.assertRaisesRegex(frappe.ValidationError, "Reopening"):
			returned.cancel()
		self.assertTrue(get_voucher_sles(returned.doctype, returned.name))

	def test_return_rejects_foreign_rows_and_changed_headers(self):
		self.make_receipt(quantity=100)
		challan = self.make_challan()
		foreign = self.make_challan()
		returned = make_return_delivery_challan(challan.name)
		returned.items[0].against_dc_item = foreign.items[0].name
		with self.assertRaisesRegex(frappe.ValidationError, "map to a row"):
			returned.insert(ignore_permissions=True)
		wrong_headers = {
			"from_location": self.from_supplier,
			"from_warehouse": self.main,
			"to_location": self.to_supplier,
			"to_warehouse": self.destination,
			"process_name": make_process(),
		}
		for fieldname, value in wrong_headers.items():
			with self.subTest(fieldname=fieldname):
				returned = make_return_delivery_challan(challan.name)
				returned.set(fieldname, value)
				with self.assertRaises(frappe.ValidationError):
					returned.insert(ignore_permissions=True)

	def test_return_requires_submitted_non_return_source_and_permissions(self):
		draft = self.make_challan(submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "submitted, non-return"):
			make_return_delivery_challan(draft.name)
		self.make_receipt()
		challan = self.make_challan()
		returned = make_return(challan, {challan.items[0].name: 10})
		with self.assertRaisesRegex(frappe.ValidationError, "submitted, non-return"):
			make_return_delivery_challan(returned.name)
		with patch("frappe.model.document.Document.check_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				make_return_delivery_challan(challan.name)
			with self.assertRaises(frappe.PermissionError):
				returned.get_return_source()
		with patch("frappe.has_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				make_return_delivery_challan(challan.name)

	def test_dc_cancel_blocked_by_return_and_grn_links(self):
		self.make_receipt()
		challan = self.make_challan()
		returned = make_return(challan, {challan.items[0].name: 10}, submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "return Delivery Challans"):
			challan.cancel()
		returned.submit()
		with self.assertRaisesRegex(frappe.ValidationError, "return Delivery Challans"):
			challan.reload().cancel()
		returned.cancel()
		challan.reload().cancel()
		self.assertFalse(get_voucher_sles(challan.doctype, challan.name))
		self.assertEqual(challan.close_status, "")
		self.assertEqual(get_stock_balance(self.item, self.main), 50)
		self.assertEqual(get_stock_balance(self.item, self.destination), 0)

	def test_dc_cancel_blocked_by_linking_grn(self):
		self.make_receipt()
		challan = self.make_challan()
		receipt = self.make_receipt(submit=False)
		link = receipt.append("delivery_challans", {"delivery_challan": challan.name})
		link.db_insert()
		for status in (0, 1):
			with self.subTest(status=status):
				receipt.db_set("docstatus", status)
				with self.assertRaisesRegex(frappe.ValidationError, receipt.name):
					challan.reload().cancel()
		receipt.db_set("docstatus", 2)
		challan.reload().cancel()
		self.assertFalse(get_voucher_sles(challan.doctype, challan.name))

	def test_dc_cancel_blocked_by_close(self):
		self.make_receipt()
		challan = self.make_challan()
		for status in ("Closed", "Reopening"):
			with self.subTest(status=status):
				challan.db_set("close_status", status)
				with self.assertRaisesRegex(frappe.ValidationError, status):
					challan.reload().cancel()
		self.assertTrue(get_voucher_sles(challan.doctype, challan.name))

	def test_dc_amend_creates_fresh_transfer_pairs(self):
		self.make_receipt()
		challan = self.make_challan()
		old_names = {entry.name for entry in get_voucher_sles(challan.doctype, challan.name)}
		challan.cancel()
		amended = frappe.copy_doc(challan)
		amended.docstatus = 0
		amended.amended_from = challan.name
		amended.insert(ignore_permissions=True).submit()
		self.assert_pair(amended, quantity=50, rate=100, source=self.main, destination=self.destination)
		self.assertFalse(
			old_names.intersection(entry.name for entry in get_voucher_sles(amended.doctype, amended.name))
		)
		self.assertTrue(amended.is_open)

	def test_dc_cancel_ignores_empty_client_items(self):
		self.make_receipt()
		challan = self.make_challan()
		persisted_rows = [row.name for row in challan.items]
		challan.set("items", [])
		challan.cancel()
		self.assertEqual([row.name for row in challan.reload().items], persisted_rows)
		self.assertEqual(challan.docstatus, 2)
		self.assertFalse(get_voucher_sles(challan.doctype, challan.name))
		self.assertEqual(get_stock_balance(self.item, self.main), 50)
		self.assertEqual(get_stock_balance(self.item, self.destination), 0)

	def test_dc_cancel_ignores_client_posting_timestamp(self):
		self.make_receipt()
		challan = self.make_challan()
		posting = (getdate(challan.posting_date), get_time(challan.posting_time))
		make_delivery_challan(
			from_warehouse=self.destination,
			to_supplier=self.from_supplier,
			to_warehouse=self.main,
			process_name=self.process_name,
			items=[{"item": self.item, "qty": 10}],
		)
		challan.posting_date = add_days(nowdate(), 1)
		challan.posting_time = "23:59:59"
		with self.assertRaisesRegex(frappe.ValidationError, "later linked movements"):
			challan.cancel()
		self.assertEqual((getdate(challan.posting_date), get_time(challan.posting_time)), posting)
		self.assertEqual(frappe.db.get_value(challan.doctype, challan.name, "docstatus"), 1)
		self.assertTrue(get_voucher_sles(challan.doctype, challan.name))

	def test_transfer_pair_assertion_rejects_missing_or_corrupt_pairs(self):
		self.make_receipt()
		challan = self.make_challan()
		entries = get_voucher_sles(challan.doctype, challan.name)
		for broken in ([], entries[:1]):
			with (
				self.subTest(count=len(broken)),
				patch("mgk_yrp.stock.ledger.get_voucher_sles", return_value=broken),
			):
				with self.assertRaises(frappe.ValidationError):
					assert_transfer_pairs(
						challan.doctype, challan.name, expected_entries=challan.get_stock_entries()
					)
		frappe.db.set_value("YRP Stock Ledger Entry", entries[0].name, "paired_stock_ledger_entry", None)
		with self.assertRaisesRegex(frappe.ValidationError, "Incomplete stock transfer pair"):
			assert_transfer_pairs(challan.doctype, challan.name)

	def test_po_receipt_revaluation_follows_dc_transfer(self):
		receipt = self.make_receipt()
		challan = self.make_challan()
		source = get_voucher_sles(receipt.doctype, receipt.name)[0]
		incoming = next(entry for entry in get_voucher_sles(challan.doctype, challan.name) if entry.qty > 0)
		with patch(f"{ADJUSTMENT}.is_stock_adjustment_enabled", return_value=True):
			adjustment = create_adjustment(
				adjustment_type="Purchase Invoice Rate Difference",
				source_doctype=receipt.doctype,
				source_name=receipt.name,
				effective_date=receipt.posting_date,
				allocations=[
					{
						"target_sle": source.name,
						"item": source.item,
						"quantity": source.qty,
						"old_rate": source.rate,
						"new_rate": 110,
						"difference": 500,
						"allocation_weight": source.qty,
						"stock_dimensions": "{}",
					}
				],
				enqueue=False,
			)
			process_adjustment(adjustment)
		self.assertEqual(
			frappe.db.get_value("YRP Stock Valuation Adjustment", adjustment, "status"), "Completed"
		)
		self.assertAlmostEqual(
			flt(frappe.db.get_value("YRP Stock Ledger Entry", incoming.name, "valuation_adjustment_value")),
			500,
		)
		quantity, rate = get_stock_balance(self.item, self.destination, with_valuation_rate=True)
		self.assertEqual(quantity, 50)
		self.assertAlmostEqual(quantity * rate, 5500)
		assert_transfer_pairs(challan.doctype, challan.name, expected_entries=challan.get_stock_entries())
