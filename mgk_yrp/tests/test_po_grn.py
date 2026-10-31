from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import get_time, getdate
from yrp.stock.dimensions import get_dimension_fieldnames
from yrp.stock.utils import get_stock_balance

from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import make_goods_received_note
from mgk_yrp.stock.ledger import get_dimension_values, get_voucher_sles
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.tests.fixtures import (
	make_item,
	make_po_grn,
	make_process,
	make_purchase_order,
	make_received_type,
	make_supplier,
	make_uom,
	make_warehouse,
)

CONTROLLER = "mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note"


class TestPurchaseOrderGRN(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.supplier = make_supplier()
		self.warehouse = make_warehouse(supplier=make_supplier(is_company_location=1))
		self.item = make_item(stock_uom=make_uom("Kg"))

	def make_order(self, *, item=None, quantities=(100,), **header):
		return make_purchase_order(
			supplier=self.supplier,
			warehouse=self.warehouse,
			items=[{"item": item or self.item, "qty": quantity, "rate": 100} for quantity in quantities],
			**header,
		)

	def test_make_grn_prefills_pending_rows(self):
		order = self.make_order(quantities=(100, 40))
		make_po_grn(order, {order.items[0].name: 30})
		receipt = make_goods_received_note(order.name)
		self.assertEqual([row.qty for row in receipt.items], [70, 40])
		self.assertEqual(receipt.supplier, order.supplier)
		self.assertEqual(receipt.delivery_location, order.delivery_location)
		self.assertEqual(receipt.warehouse, order.warehouse)
		self.assertEqual(receipt.against_purchase_order, 1)
		self.assertTrue(getdate(receipt.posting_date))
		self.assertTrue(get_time(receipt.posting_time))
		self.assertEqual(receipt.items[0].purchase_order_item, order.items[0].name)
		self.assertEqual(receipt.items[0].rate, 100)
		self.assertEqual(receipt.items[0].conversion_factor, order.items[0].conversion_factor)
		receipt.items[0].qty = 20
		receipt.set("items", receipt.items[:1])
		receipt.insert(ignore_permissions=True).submit()
		self.assertEqual(receipt.items[0].qty, 20)
		make_po_grn(order, {order.items[1].name: 40})
		remaining = make_goods_received_note(order.name)
		self.assertEqual(len(remaining.items), 1)
		self.assertEqual(remaining.items[0].qty, 50)

	def test_grn_received_type_copies_po_and_remains_editable(self):
		order = self.make_order()
		receipt = make_goods_received_note(order.name)
		self.assertEqual(receipt.items[0].get("received_type"), order.items[0].get("received_type"))
		receipt.items[0].received_type = make_received_type(f"MGK Test Type {frappe.generate_hash(length=8)}")
		receipt.insert(ignore_permissions=True).submit()
		entry = frappe.get_doc(
			"YRP Stock Ledger Entry", get_voucher_sles(receipt.doctype, receipt.name)[0].name
		)
		for field, value in get_dimension_values(receipt.items[0]).items():
			self.assertEqual(entry.get(field), value)

	def test_one_po_row_received_as_accepted_and_rejected_with_combined_cap(self):
		if "received_type" not in get_dimension_fieldnames():
			self.skipTest("Received Type dimension is not configured")
		accepted, rejected = (make_received_type(value) for value in ("Accepted", "Rejected"))
		order = self.make_order(quantities=(10,))
		receipt = make_goods_received_note(order.name)
		receipt.items[0].qty = 6
		receipt.items[0].received_type = accepted
		receipt.append("items", {"item": self.item, "qty": 5, "received_type": rejected})
		receipt.insert(ignore_permissions=True)
		self.assertEqual([row.purchase_order_item for row in receipt.items], [order.items[0].name] * 2)
		with self.assertRaisesRegex(frappe.ValidationError, "exceeds the allowed quantity"):
			receipt.submit()
		receipt.reload()
		receipt.items[1].qty = 4
		receipt.save().submit()
		self.assertEqual(order.reload().items[0].received_qty, 10)
		self.assertEqual(order.items[0].pending_qty, 0)
		for value, quantity in ((accepted, 6), (rejected, 4)):
			self.assertEqual(get_stock_balance(self.item, self.warehouse, received_type=value), quantity)

	def test_po_grn_rate_cannot_be_overridden(self):
		order = self.make_order()
		receipt = make_goods_received_note(order.name)
		receipt.items[0].rate = 1
		receipt.supplier = make_supplier()
		receipt.delivery_location = receipt.supplier
		receipt.warehouse = None
		receipt.insert(ignore_permissions=True)
		self.assertEqual(receipt.items[0].rate, 100)
		self.assertEqual(receipt.supplier, order.supplier)
		self.assertEqual(receipt.delivery_location, order.delivery_location)
		self.assertEqual(receipt.warehouse, order.warehouse)
		receipt.items[0].rate = 2
		receipt.submit()
		self.assertEqual(receipt.items[0].rate, 100)
		self.assertEqual(receipt.total_amount, 10000)

	def test_po_grn_inherits_process_on_insert(self):
		order = self.make_order(process_name=make_process())
		receipt = make_po_grn(order, submit=False)
		self.assertEqual(receipt.process_name, order.process_name)
		self.assertEqual(receipt.reload().process_name, order.process_name)

	def test_po_grn_overwrites_manual_process(self):
		order = self.make_order(process_name=make_process())
		receipt = make_goods_received_note(order.name)
		receipt.process_name = make_process()
		receipt.insert(ignore_permissions=True)
		self.assertEqual(receipt.process_name, order.process_name)

	def test_po_without_process_clears_grn_process(self):
		order = self.make_order()
		receipt = make_goods_received_note(order.name)
		receipt.process_name = make_process()
		receipt.insert(ignore_permissions=True)
		self.assertFalse(receipt.process_name)

	def test_po_grn_rejects_foreign_po_row(self):
		order, foreign = self.make_order(), self.make_order()
		receipt = make_goods_received_note(order.name)
		receipt.items[0].purchase_order_item = foreign.items[0].name
		with self.assertRaisesRegex(frappe.ValidationError, "Row 1: Item must map to a row of this Purchase Order."):
			receipt.insert(ignore_permissions=True)

	def test_po_grn_rejects_changed_item(self):
		receipt = make_goods_received_note(self.make_order().name)
		receipt.items[0].item = make_item(stock_uom=make_uom("Kg"))
		with self.assertRaisesRegex(frappe.ValidationError, "map to a row"):
			receipt.insert(ignore_permissions=True)

	def test_po_grn_uom_snapshot_mismatch_throws(self):
		order = self.make_order()
		for fieldname, value in (("uom", "Nos"), ("stock_uom", "Nos"), ("conversion_factor", 2)):
			with self.subTest(fieldname=fieldname):
				make_uom("Nos")
				receipt = make_goods_received_note(order.name)
				receipt.items[0].set(fieldname, value)
				with self.assertRaisesRegex(frappe.ValidationError, "different"):
					receipt.insert(ignore_permissions=True)
		receipt = make_po_grn(order, submit=False)
		receipt.items[0].conversion_factor = 2
		with self.assertRaisesRegex(frappe.ValidationError, "different"):
			receipt.save()

	def test_po_grn_new_row_copies_missing_snapshot(self):
		order = self.make_order()
		receipt = make_goods_received_note(order.name)
		for fieldname in ("uom", "stock_uom", "conversion_factor"):
			receipt.items[0].set(fieldname, None)
		receipt.insert(ignore_permissions=True)
		self.assertEqual(receipt.items[0].uom, order.items[0].uom)
		self.assertEqual(receipt.items[0].conversion_factor, 1)

	def test_po_grn_keeps_snapshot_after_item_master_changes(self):
		item = make_item(stock_uom=make_uom("Kg"), purchase_uom=make_uom("Bag"), conversion_factor=50)
		order = self.make_order(item=item, quantities=(2,))
		receipt = make_po_grn(order, submit=False)
		parent = frappe.db.get_value("Item", item, "variant_of")
		frappe.db.set_value(
			"UOM Conversion Detail", {"parent": parent, "uom": "Bag"}, "conversion_factor", 60
		)
		frappe.clear_document_cache("Item", parent)
		receipt.submit()
		self.assertEqual(receipt.items[0].conversion_factor, 50)
		self.assertEqual(receipt.items[0].stock_qty, 100)

	def test_over_receipt_capped_by_allowance(self):
		item = make_item(stock_uom=make_uom("Kg"), excess_percent=10)
		order = self.make_order(item=item)
		stale = make_po_grn(order, {order.items[0].name: 1}, submit=False)
		make_po_grn(order, {order.items[0].name: 110})
		with self.assertRaisesRegex(frappe.ValidationError, "allowed quantity"):
			stale.submit()
		strict = self.make_order()
		with self.assertRaisesRegex(frappe.ValidationError, "allowed quantity"):
			make_po_grn(strict, {strict.items[0].name: 101})

	def test_receipt_allowance_sums_duplicate_source_rows(self):
		order = self.make_order()
		receipt = make_goods_received_note(order.name)
		receipt.items[0].qty = 60
		duplicate = receipt.items[0].as_dict()
		duplicate.pop("name", None)
		receipt.append("items", duplicate)
		receipt.insert(ignore_permissions=True)
		with self.assertRaisesRegex(frappe.ValidationError, "allowed quantity"):
			receipt.submit()

	def test_receipt_cap_rechecked_after_po_lock(self):
		order = self.make_order()
		receipt = make_po_grn(order, {order.items[0].name: 60}, submit=False)
		make_po_grn(order, {order.items[0].name: 50})
		with patch("mgk_yrp.stock.locking.lock_documents", wraps=lock_documents) as locks:
			with self.assertRaisesRegex(frappe.ValidationError, "allowed quantity"):
				receipt.submit()
		self.assertEqual(
			locks.call_args.args[0],
			{
				"MGK Purchase Order": [order.name],
				"MGK Goods Received Note": [receipt.name],
			},
		)

	def test_po_received_qty_and_status(self):
		order = self.make_order(quantities=(100, 40))
		first = make_po_grn(order, {order.items[0].name: 30})
		order.reload()
		self.assertEqual(order.status, "Partially Received")
		self.assertEqual(order.items[0].received_qty, 30)
		self.assertEqual(order.items[0].pending_qty, 70)
		self.assertEqual(order.items[1].pending_qty, 40)
		second = make_po_grn(order)
		order.reload()
		self.assertEqual(order.status, "Completed")
		self.assertEqual([row.pending_qty for row in order.items], [0, 0])
		second.cancel()
		order.reload()
		self.assertEqual(order.status, "Partially Received")
		self.assertEqual(order.items[0].received_qty, 30)
		first.cancel()
		order.reload()
		self.assertEqual(order.status, "To Receive")
		self.assertEqual([row.pending_qty for row in order.items], [100, 40])

	def test_receipt_sle_uses_stock_uom_rate(self):
		item = make_item(stock_uom=make_uom("Kg"), purchase_uom=make_uom("Bag"), conversion_factor=50)
		order = make_purchase_order(
			supplier=self.supplier,
			warehouse=self.warehouse,
			items=[{"item": item, "qty": 2, "rate": 5000}],
		)
		receipt = make_po_grn(order)
		entries = get_voucher_sles(receipt.doctype, receipt.name)
		self.assertEqual(len(entries), 1)
		self.assertEqual(entries[0].qty, 100)
		self.assertEqual(entries[0].rate, 100)
		self.assertEqual(entries[0].stock_value_difference, 10000)
		self.assertEqual(get_stock_balance(item, self.warehouse, with_valuation_rate=True), (100, 100))
		receipt.reload()
		self.assertEqual(receipt.items[0].rate, 5000)
		self.assertEqual(receipt.items[0].stock_rate, 100)
		self.assertEqual(receipt.total_amount, 10000)

	def test_amend_creates_fresh_postings(self):
		order = self.make_order()
		receipt = make_po_grn(order)
		old_names = {row.name for row in get_voucher_sles(receipt.doctype, receipt.name)}
		receipt.cancel()
		amended = frappe.copy_doc(receipt)
		amended.docstatus = 0
		amended.amended_from = receipt.name
		amended.insert(ignore_permissions=True).submit()
		self.assertNotEqual(amended.name, receipt.name)
		new_entries = get_voucher_sles(amended.doctype, amended.name)
		self.assertTrue(new_entries)
		self.assertFalse(old_names.intersection(row.name for row in new_entries))
		for name in old_names:
			self.assertEqual(frappe.db.get_value("YRP Stock Ledger Entry", name, "is_cancelled"), 1)
		self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))
		order.reload()
		self.assertEqual(order.items[0].received_qty, 100)
		self.assertEqual(get_stock_balance(self.item, self.warehouse), 100)

	def test_cancel_ignores_empty_client_items(self):
		order = self.make_order()
		receipt = make_po_grn(order)
		persisted_rows = [row.name for row in receipt.items]
		receipt.set("items", [])
		receipt.cancel()
		self.assertEqual([row.name for row in receipt.reload().items], persisted_rows)
		self.assertEqual(receipt.docstatus, 2)
		self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))
		self.assertEqual(get_stock_balance(self.item, self.warehouse), 0)
		self.assertEqual(order.reload().items[0].received_qty, 0)

	def test_make_grn_requires_po_read_permission(self):
		order = self.make_order()
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": f"mgk-grn-{frappe.generate_hash(length=8)}@example.com",
				"first_name": "MGK GRN Test",
				"send_welcome_email": 0,
				"roles": [{"role": "Item Manager"}],
			}
		).insert(ignore_permissions=True)
		self.addCleanup(frappe.set_user, frappe.session.user)
		frappe.set_user(user.name)
		with self.assertRaises(frappe.PermissionError):
			make_goods_received_note(order.name)

	def test_stock_user_can_load_po_linked_grn_editor_details(self):
		from mgk_yrp.stock.item_editor import get_item_details

		order = self.make_order()
		receipt = make_po_grn(order)
		user = frappe.get_doc({
			"doctype": "User", "email": f"mgk-stock-{frappe.generate_hash(length=8)}@example.com",
			"first_name": "MGK Stock Test", "send_welcome_email": 0,
			"roles": [{"role": "Stock User"}],
		}).insert(ignore_permissions=True)
		self.addCleanup(frappe.set_user, frappe.session.user)
		frappe.set_user(user.name)
		receipt = frappe.get_doc(receipt.doctype, receipt.name)
		receipt.check_permission("read")
		self.assertTrue(get_item_details(receipt))
		receipt.onload()
		self.assertTrue(receipt.get_onload().item_details)

	def test_po_grn_controller_requires_po_read_permission(self):
		receipt = make_goods_received_note(self.make_order().name)
		with patch("frappe.model.document.Document.check_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				receipt.validate_purchase_order()

	def test_po_grn_requires_submitted_order(self):
		order = self.make_order(submit=False)
		with self.assertRaises(frappe.ValidationError):
			make_goods_received_note(order.name)
		order.submit()
		receipt = make_po_grn(order, submit=False)
		order.cancel()
		with self.assertRaisesRegex(frappe.ValidationError, "must be submitted"):
			receipt.validate_purchase_order()

	def test_po_cancel_blocked_by_submitted_grn(self):
		order = self.make_order()
		receipt = make_po_grn(order)
		with self.assertRaisesRegex(frappe.ValidationError, receipt.name):
			order.cancel()
		self.assertEqual(frappe.db.get_value(order.doctype, order.name, "docstatus"), 1)
		receipt.cancel()
		order.reload().cancel()
		self.assertEqual(order.status, "Cancelled")

	def test_grn_rejects_negative_quantity(self):
		order = self.make_order()
		with self.assertRaisesRegex(frappe.ValidationError, "positive"):
			make_po_grn(order, {order.items[0].name: -1}, submit=False)

	def test_grn_keeps_zero_draft_rows_and_drops_them_at_submit(self):
		order = self.make_order(quantities=(100, 40))
		receipt = make_po_grn(order, {order.items[0].name: 0, order.items[1].name: 10}, submit=False)
		self.assertEqual([row.qty for row in receipt.reload().items], [0, 10])
		receipt.submit()
		self.assertEqual([row.qty for row in receipt.items], [10])
		self.assertEqual(receipt.items[0].purchase_order_item, order.items[1].name)
		self.assertEqual([row.qty for row in get_voucher_sles(receipt.doctype, receipt.name)], [10])

	def test_grn_rejects_submit_with_only_zero_rows(self):
		order = self.make_order()
		receipt = make_po_grn(order, {order.items[0].name: 0}, submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "positive quantity"):
			receipt.submit()
		self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))
