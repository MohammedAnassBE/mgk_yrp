from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from yrp.stock.utils import get_stock_balance

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import (
	MGKDeliveryChallan,
	make_return_delivery_challan,
)
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import (
	make_goods_received_note,
	mark_as_received,
)
from mgk_yrp.party_defaults import get_head_office
from mgk_yrp.stock.ledger import get_voucher_sles
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


class HeadOfficeTestCase(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.enterContext(patch("frappe.enqueue"))
		frappe.db.set_value("Supplier", {"mgk_is_head_office": 1}, "mgk_is_head_office", 0)

	def make_head_office(self):
		name = make_supplier(is_company_location=1)
		supplier = frappe.get_doc("Supplier", name)
		supplier.mgk_is_head_office = 1
		supplier.save()
		return supplier


class TestHeadOffice(HeadOfficeTestCase):
	def test_head_office_requires_company_location_on_setting_and_unticking(self):
		supplier = frappe.get_doc("Supplier", make_supplier())
		supplier.mgk_is_head_office = 1
		with self.assertRaisesRegex(
			frappe.ValidationError, "A Head Office supplier must also be a Company Location"
		):
			supplier.save()
		supplier.reload()
		supplier.mgk_is_head_office = 1
		supplier.is_company_location = 1
		supplier.save()
		supplier.is_company_location = 0
		with self.assertRaisesRegex(
			frappe.ValidationError, "A Head Office supplier must also be a Company Location"
		):
			supplier.save()

	def test_second_head_office_names_existing_even_when_disabled(self):
		first = self.make_head_office()
		for disabled in (0, 1):
			with self.subTest(disabled=disabled):
				frappe.db.set_value("Supplier", first.name, "disabled", disabled)
				with self.assertRaisesRegex(
					frappe.ValidationError, f"{first.name} is already the Head Office"
				):
					self.make_head_office()
		first.reload().save()

	def test_head_office_lookup_missing(self):
		with self.assertRaisesRegex(
			frappe.ValidationError, "Set Is Head Office on the Head Office supplier first"
		):
			get_head_office()

	def test_head_office_lookup_disabled(self):
		supplier = self.make_head_office()
		frappe.db.set_value("Supplier", supplier.name, "disabled", 1)
		with self.assertRaisesRegex(frappe.ValidationError, f"Head Office {supplier.name} is disabled"):
			get_head_office()

	def test_head_office_lookup_requires_exactly_one_enabled_leaf_warehouse(self):
		supplier = self.make_head_office()
		with self.assertRaisesRegex(frappe.ValidationError, "must have exactly one warehouse; found 0"):
			get_head_office()
		active, disabled, group = [make_warehouse(supplier=supplier.name) for _ in range(3)]
		frappe.db.set_value("Warehouse", disabled, "disabled", 1)
		frappe.db.set_value("Warehouse", group, "is_group", 1)
		self.assertEqual(get_head_office(), {"location": supplier.name, "warehouse": active})
		make_warehouse(supplier=supplier.name)
		with self.assertRaisesRegex(frappe.ValidationError, "must have exactly one warehouse; found 2"):
			get_head_office()


class TestMarkAsReceived(HeadOfficeTestCase):
	def setUp(self):
		previous = frappe.db.get_single_value("YRP Stock Settings", "transit_warehouse", cache=False)
		# Register before the parent's rollback so restoration runs afterwards.
		self.addCleanup(frappe.clear_document_cache, "YRP Stock Settings", "YRP Stock Settings")
		self.addCleanup(frappe.db.set_single_value, "YRP Stock Settings", "transit_warehouse", previous)
		super().setUp()
		self.head_office = self.make_head_office().name
		self.main = make_warehouse(supplier=self.head_office)
		self.location = make_supplier(is_company_location=1)
		self.warehouse = make_warehouse(supplier=self.location)
		self.supplier = make_supplier()
		self.worker = make_supplier()
		self.job = make_warehouse(supplier=self.worker)
		self.process = make_process()
		self.item = make_item(stock_uom=make_uom("Kg"))

	def make_order(self, *, is_direct=False, items=None, **header):
		return make_purchase_order(
			supplier=self.supplier,
			warehouse=self.job if is_direct else self.warehouse,
			delivery_location=self.worker if is_direct else self.location,
			deliver_to_supplier=int(is_direct),
			process_name=self.process if is_direct else None,
			items=items or [{"item": self.item, "qty": 10, "rate": 125}],
			**header,
		)

	def receive(self, order):
		result = mark_as_received(order.name)
		receipt = frappe.get_doc("MGK Goods Received Note", result["goods_received_note"])
		challan = (
			frappe.get_doc("MGK Delivery Challan", result["delivery_challan"])
			if result["delivery_challan"]
			else None
		)
		return receipt, challan

	def typed_rows(self):
		return [
			{"item": self.item, "qty": qty, "rate": 125, "received_type": make_received_type(value)}
			for value, qty in (("Accepted", 6), ("Rejected", 4))
		]

	def test_c1_manual_half_then_mark_as_received_delivers_only_pending_half(self):
		order = self.make_order(is_direct=True, items=[{"item": self.item, "qty": 100, "rate": 125}])
		manual = make_po_grn(order, {order.items[0].name: 50})
		receipt, challan = self.receive(order)
		self.assertEqual((manual.total_qty, receipt.total_qty, challan.total_qty), (50, 50, 50))
		self.assertEqual(order.reload().status, "Completed")
		self.assertEqual((order.items[0].received_qty, order.items[0].pending_qty), (100, 0))

	def test_t15_internal_mark_as_received_rejects_deliver_to_supplier_before_writes(self):
		order = self.make_order(is_direct=True)
		frappe.db.set_value("Supplier", self.supplier, "is_company_location", 1)
		with patch("frappe.new_doc") as create, patch("mgk_yrp.purchase.receipt.lock_stock_buckets") as buckets:
			with self.assertRaisesRegex(frappe.ValidationError, "internal transfer; cannot Deliver to Supplier"):
				self.receive(order)
			create.assert_not_called()
			buckets.assert_not_called()
		self.assertFalse(frappe.db.exists("MGK Goods Received Note", {"purchase_order": order.name}))
		self.assertEqual(order.reload().items[0].pending_qty, 10)

	def test_r10_internal_mark_as_received_locks_transit_before_insert(self):
		from mgk_yrp.stock.locking import lock_stock_buckets

		order = self.make_order()
		frappe.db.set_value("Supplier", self.supplier, "is_company_location", 1)
		warehouse = make_warehouse()
		frappe.db.set_single_value("YRP Stock Settings", "transit_warehouse", warehouse)
		with patch("mgk_yrp.purchase.receipt.lock_stock_buckets", wraps=lock_stock_buckets) as buckets:
			receipt, challan = self.receive(order)
		buckets.assert_called_once_with([(self.item, warehouse)])
		self.assertEqual(get_voucher_sles(receipt.doctype, receipt.name)[0].warehouse, warehouse)
		self.assertEqual(receipt.transfer_status, "In Transit")
		self.assertIsNone(challan)

	def test_process_required_only_for_deliver_to_supplier_and_kept_when_off(self):
		order = self.make_order(is_direct=True, submit=False)
		order.process_name = None
		with self.assertRaisesRegex(
			frappe.ValidationError, "Process is required when Deliver to Supplier is ticked"
		):
			order.save()
		order.reload()
		order.process_name = self.process
		order.deliver_to_supplier = 0
		order.delivery_location, order.warehouse = self.location, self.warehouse
		order.save()
		self.assertEqual(order.reload().process_name, self.process)

	def test_delivery_location_must_match_company_or_job_worker(self):
		order = self.make_order(submit=False)
		order.delivery_location = self.worker
		with self.assertRaisesRegex(frappe.ValidationError, f"{self.worker} must be a Company Location"):
			order.save()
		order.reload()
		order.deliver_to_supplier, order.process_name = 1, self.process
		order.delivery_location = self.location
		with self.assertRaisesRegex(
			frappe.ValidationError, f"{self.location} must not be a Company Location"
		):
			order.save()

	def test_manual_direct_grn_receives_at_head_office_without_dc(self):
		order = self.make_order(is_direct=True)
		receipt = make_goods_received_note(order.name)
		self.assertEqual((receipt.delivery_location, receipt.warehouse), (self.head_office, self.main))
		receipt.delivery_location, receipt.warehouse = self.worker, None
		receipt.insert().submit()
		self.assertEqual((receipt.delivery_location, receipt.warehouse), (self.head_office, self.main))
		self.assertFalse(frappe.db.exists("MGK Delivery Challan", {"purchase_order": order.name}))

	def test_company_receipt_full_pending_with_each_received_type(self):
		order = self.make_order(items=self.typed_rows())
		receipt, challan = self.receive(order)
		self.assertIsNone(challan)
		self.assertEqual(receipt.docstatus, 1)
		self.assertEqual(self.receipt_names(order), [receipt.name])
		self.assertFalse(frappe.db.exists("MGK Delivery Challan", {"purchase_order": order.name}))
		self.assertEqual((receipt.delivery_location, receipt.warehouse), (self.location, self.warehouse))
		self.assertEqual([row.qty for row in receipt.items], [6, 4])
		self.assertEqual(order.reload().status, "Completed")
		self.assertEqual([row.pending_qty for row in order.items], [0, 0])
		self.assertEqual(len(get_voucher_sles(receipt.doctype, receipt.name)), 2)
		self.assert_type_legs(receipt, None)

	def test_direct_receipt_and_transfer_rows_types_legs_and_value(self):
		order = self.make_order(is_direct=True, items=self.typed_rows())
		receipt, challan = self.receive(order)
		self.assertEqual((receipt.docstatus, challan.docstatus), (1, 1))
		self.assertEqual(self.receipt_names(order), [receipt.name])
		self.assertEqual((receipt.delivery_location, receipt.warehouse), (self.head_office, self.main))
		self.assertEqual((challan.from_location, challan.from_warehouse), (self.head_office, self.main))
		self.assertEqual((challan.to_location, challan.to_warehouse), (self.worker, self.job))
		self.assertEqual(challan.process_name, self.process)
		self.assertEqual((challan.purchase_order, challan.goods_received_note), (order.name, receipt.name))
		with patch(f"{MGKDeliveryChallan.__module__}.lock_documents") as locks:
			challan.lock_sources(previous=challan)
		locks.assert_called_once_with(
			{
				"MGK Purchase Order": [order.name, order.name],
				"MGK Delivery Challan": [None, None, challan.name, challan.name],
				"MGK Goods Received Note": [receipt.name],
			}
		)
		for actual, expected in zip(challan.items, receipt.items, strict=True):
			self.assertEqual(actual.goods_received_note, receipt.name)
			self.assertEqual(actual.goods_received_note_item, expected.name)
			for field in (
				"item",
				"qty",
				"stock_qty",
				"received_type",
				"rate",
				"uom",
				"stock_uom",
				"conversion_factor",
			):
				self.assertEqual(actual.get(field), expected.get(field), field)
		self.assertEqual(order.reload().status, "Completed")
		self.assert_type_legs(receipt, challan)
		self.assertEqual(get_stock_balance(self.item, self.main), 0)
		outgoing = [entry for entry in get_voucher_sles(challan.doctype, challan.name) if entry.qty < 0]
		self.assertEqual(-sum(entry.stock_value_difference for entry in outgoing), receipt.total_amount)

	def assert_type_legs(self, receipt, challan):
		for row in receipt.items:
			filters = {"voucher_no": receipt.name, "voucher_detail_no": row.name, "is_cancelled": 0}
			entry = frappe.db.get_value(
				"YRP Stock Ledger Entry", filters, ["warehouse", "qty", "received_type"], as_dict=True
			)
			self.assertEqual(
				(entry.warehouse, entry.qty, entry.received_type),
				(receipt.warehouse, row.stock_qty, row.received_type),
			)
			if challan:
				legs = frappe.get_all(
					"YRP Stock Ledger Entry",
					filters={
						"voucher_no": challan.name,
						"received_type": row.received_type,
						"is_cancelled": 0,
					},
					fields=["warehouse", "qty"],
				)
				self.assertEqual(
					{(leg.warehouse, leg.qty) for leg in legs},
					{(self.main, -row.stock_qty), (self.job, row.stock_qty)},
				)

	def test_purchase_uom_snapshot_survives_item_master_change(self):
		item = make_item(stock_uom=make_uom("Kg"), purchase_uom=make_uom("Bag"), conversion_factor=50)
		order = self.make_order(is_direct=True, items=[{"item": item, "qty": 2, "rate": 5000}])
		parent = frappe.db.get_value("Item", item, "variant_of")
		frappe.db.set_value(
			"UOM Conversion Detail", {"parent": parent, "uom": "Bag"}, "conversion_factor", 25
		)
		frappe.clear_document_cache("Item", parent)
		receipt, challan = self.receive(order)
		for row in (receipt.items[0], challan.items[0]):
			self.assertEqual(
				(row.uom, row.stock_uom, row.conversion_factor, row.qty, row.stock_qty),
				("Bag", "Kg", 50, 2, 100),
			)
		self.assertEqual(get_stock_balance(item, self.main), 0)
		self.assertEqual(get_stock_balance(item, self.job), 100)

	def test_partial_receipt_only_receives_pending_and_second_call_creates_nothing(self):
		order = self.make_order()
		make_po_grn(order, {order.items[0].name: 3})
		receipt, _challan = self.receive(order)
		self.assertEqual(receipt.items[0].qty, 7)
		before = self.receipt_names(order)
		with self.assertRaisesRegex(
			frappe.ValidationError, f"Purchase Order {order.name} is already fully received"
		):
			mark_as_received(order.name)
		self.assertEqual(self.receipt_names(order), before)

	def test_draft_and_cancelled_orders_cannot_be_received(self):
		order = self.make_order(submit=False)
		for is_cancelled in (False, True):
			if is_cancelled:
				order.submit().cancel()
			with self.assertRaisesRegex(frappe.ValidationError, "must be submitted"):
				mark_as_received(order.name)
			self.assert_no_receipt(order)

	def test_permission_preflight_denies_missing_grn_submit_before_writes(self):
		order = self.make_order()
		role = f"MGK Receipt Creator {frappe.generate_hash(length=8)}"
		frappe.get_doc({"doctype": "Role", "role_name": role}).insert()
		frappe.get_doc(
			{
				"doctype": "Custom DocPerm",
				"parent": "MGK Goods Received Note",
				"role": role,
				"permlevel": 0,
				"read": 1,
				"create": 1,
				"write": 1,
			}
		).insert()
		frappe.clear_cache(doctype="MGK Goods Received Note")
		self.addCleanup(frappe.clear_cache, doctype="MGK Goods Received Note")
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": f"mgk-receive-{frappe.generate_hash(length=8)}@example.com",
				"first_name": "Receipt Reader",
				"send_welcome_email": 0,
				"roles": [{"role": "Purchase User"}, {"role": role}],
			}
		).insert()
		frappe.set_user(user.email)
		try:
			self.assertTrue(frappe.has_permission("MGK Goods Received Note", "create"))
			self.assertFalse(frappe.has_permission("MGK Goods Received Note", "submit"))
			with self.assertRaises(frappe.PermissionError):
				mark_as_received(order.name)
		finally:
			frappe.set_user("Administrator")
		self.assert_no_receipt(order)

	def test_each_required_permission_is_checked_before_lock_or_mapper(self):
		order = self.make_order(is_direct=True)
		for doctype, permission in (
			("MGK Goods Received Note", "create"),
			("MGK Goods Received Note", "submit"),
			("MGK Delivery Challan", "create"),
			("MGK Delivery Challan", "submit"),
		):

			def has_permission(target, ptype, **kwargs):
				if (target, ptype) == (doctype, permission):
					raise frappe.PermissionError
				return True

			with (
				self.subTest(doctype=doctype, permission=permission),
				patch("frappe.has_permission", side_effect=has_permission),
				patch("mgk_yrp.purchase.receipt.lock_documents") as lock,
			):
				with self.assertRaises(frappe.PermissionError):
					mark_as_received(order.name)
				lock.assert_not_called()
		self.assert_no_receipt(order)

	def test_missing_head_office_creates_nothing(self):
		order = self.make_order(is_direct=True)
		frappe.db.set_value("Supplier", self.head_office, "mgk_is_head_office", 0)
		with self.assertRaisesRegex(frappe.ValidationError, "Set Is Head Office"):
			mark_as_received(order.name)
		self.assert_no_receipt(order)

	def test_dc_failure_rolls_back_receipt_stock_and_pending_at_both_hooks(self):
		for hook in ("before_submit", "on_submit"):
			order = self.make_order(is_direct=True)
			original = getattr(MGKDeliveryChallan, hook)

			def fail(challan):
				original(challan)
				raise RuntimeError("forced DC failure")

			with self.subTest(hook=hook), patch.object(MGKDeliveryChallan, hook, fail):
				with self.assertRaisesRegex(RuntimeError, "forced DC failure"):
					mark_as_received(order.name)
			self.assert_no_receipt(order)
			self.assertEqual(get_stock_balance(self.item, self.main), 0)
			self.assertEqual(get_stock_balance(self.item, self.job), 0)

	def receipt_names(self, order):
		return frappe.get_all("MGK Goods Received Note", filters={"purchase_order": order.name}, pluck="name")

	def assert_no_receipt(self, order):
		self.assertFalse(self.receipt_names(order))
		self.assertFalse(
			frappe.db.exists(
				"MGK Goods Received Note Item",
				{"purchase_order_item": ["in", [row.name for row in order.items]]},
			)
		)
		self.assertFalse(frappe.db.exists("MGK Delivery Challan", {"purchase_order": order.name}))
		self.assertFalse(frappe.db.exists("YRP Stock Ledger Entry", {"item": self.item}))
		self.assertEqual(order.reload().items[0].pending_qty, 10)
		self.assertEqual(order.items[0].received_qty, 0)

	def test_dc_source_consistency_and_return_sources_are_empty(self):
		order = self.make_order(is_direct=True)
		receipt, challan = self.receive(order)
		for values in (
			{"purchase_order": None},
			{"goods_received_note": None},
			{"purchase_order": self.make_order().name},
			{"from_warehouse": self.warehouse},
			{"is_return": 1},
		):
			candidate = frappe.get_doc(challan.as_dict())
			candidate.update(values)
			with self.subTest(values=values), self.assertRaises(frappe.ValidationError):
				candidate.validate_purchase_receipt()
		frappe.db.set_value(receipt.doctype, receipt.name, "docstatus", 0)
		with self.assertRaisesRegex(frappe.ValidationError, "submitted"):
			challan.validate_purchase_receipt()
		frappe.db.set_value(receipt.doctype, receipt.name, "docstatus", 1)
		returned = make_return_delivery_challan(challan.name)
		self.assertFalse(returned.purchase_order)
		self.assertFalse(returned.goods_received_note)

	def test_cancel_guards_then_dc_grn_po_cancel_order(self):
		order = self.make_order(is_direct=True)
		receipt, challan = self.receive(order)
		with self.assertRaisesRegex(
			frappe.ValidationError,
			f"Cancel Delivery Challan {challan.name} first, then Goods Received Note {receipt.name}",
		):
			order.reload().cancel()
		with self.assertRaisesRegex(
			frappe.ValidationError, f"Cancel Delivery Challan {challan.name} before this receipt"
		):
			receipt.reload().cancel()
		challan.reload().cancel()
		receipt.reload().cancel()
		order.reload().cancel()
		self.assertEqual([doc.docstatus for doc in (challan, receipt, order)], [2, 2, 2])

	def test_plain_grn_keeps_existing_po_cancel_message(self):
		order = self.make_order()
		receipt, _challan = self.receive(order)
		with self.assertRaisesRegex(
			frappe.ValidationError, f"Cancel submitted Goods Received Notes first: {receipt.name}"
		):
			order.reload().cancel()
