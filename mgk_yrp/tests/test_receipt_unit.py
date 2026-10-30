from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call, patch

import frappe

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import MGKDeliveryChallan
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import (
	MGKPurchaseOrder,
	make_goods_received_note,
)
from mgk_yrp.overrides.supplier import validate
from mgk_yrp.party_defaults import get_head_office
from mgk_yrp.purchase.receipt import PurchaseReceipt
from mgk_yrp.tests.test_item_editor import EditorDocument, make_row, validation_error

ORDER = MGKPurchaseOrder.__module__
CHALLAN = MGKDeliveryChallan.__module__
RECEIPT = MGKGoodsReceivedNote.__module__
FLOW = "mgk_yrp.purchase.receipt"


class TestReceiptUnit(TestCase):
	def setUp(self):
		self.database = Mock()
		self.database.sql.return_value = []
		self.database.is_deadlocked.return_value = False
		self.database.is_timedout.return_value = False
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", side_effect=validation_error))
		self.enterContext(patch("frappe._", side_effect=lambda message: message))
		self.enterContext(patch(f"{FLOW}.is_internal_route", return_value=False))
		for module in (ORDER, CHALLAN, RECEIPT, FLOW, "mgk_yrp.overrides.supplier", "mgk_yrp.stock.uom"):
			self.enterContext(patch(f"{module}._", side_effect=lambda message: message))
		self.order = SimpleNamespace(
			doctype="MGK Purchase Order",
			name="PO-1",
			docstatus=1,
			deliver_to_supplier=0,
			supplier="Supplier",
			delivery_location="Own",
			warehouse="Own WH",
			receipt_location={"location": "Own", "warehouse": "Own WH"},
			process_name=None,
			flags=frappe._dict(),
			items=[make_row(name="PO-row", pending_qty=7)],
			check_permission=Mock(),
			reload=Mock(),
		)

	def test_supplier_rules_include_disabled_head_office_and_ignore_self(self):
		doc = frappe._dict(name="Other", mgk_is_head_office=1, is_company_location=0)
		with self.assertRaisesRegex(frappe.ValidationError, "must also be a Company Location"):
			validate(doc)
		self.database.get_value.assert_not_called()
		doc.is_company_location = 1
		self.database.get_value.return_value = "Existing HO"
		with self.assertRaisesRegex(frappe.ValidationError, "Existing HO is already the Head Office"):
			validate(doc)
		filters = self.database.get_value.call_args.args[1]
		self.assertEqual(filters, {"mgk_is_head_office": 1, "name": ["!=", "Other"]})
		self.assertTrue(self.database.get_value.call_args.kwargs["for_update"])
		doc.mgk_is_head_office = 0
		validate(doc)

	def test_head_office_uses_shared_warehouse_candidates(self):
		self.database.get_value.return_value = "HO"
		supplier = SimpleNamespace(disabled=0, check_permission=Mock())
		warehouse = SimpleNamespace(check_permission=Mock())
		with (
			patch("frappe.get_doc", side_effect=[supplier, warehouse]),
			patch(
				"mgk_yrp.party_defaults.get_warehouse_candidates", return_value=[frappe._dict(name="HO WH")]
			) as candidates,
		):
			self.assertEqual(get_head_office(), {"location": "HO", "warehouse": "HO WH"})
		candidates.assert_called_once_with("HO", ignore_permissions=True)
		supplier.check_permission.assert_called_once_with("read")
		warehouse.check_permission.assert_called_once_with("read")

	def test_head_office_rejects_multiple_warehouses_even_if_only_one_is_visible(self):
		self.database.get_value.return_value = "HO"
		supplier = SimpleNamespace(disabled=0, check_permission=Mock())
		visible = frappe._dict(name="Visible WH")
		with (
			patch("frappe.get_doc", return_value=supplier) as get_doc,
			patch("frappe.get_list", return_value=[visible]) as visible_query,
			patch("frappe.get_all", return_value=[visible, frappe._dict(name="Hidden WH")]) as query,
		):
			with self.assertRaisesRegex(
				frappe.ValidationError, "HO must have exactly one warehouse; found 2"
			):
				get_head_office()
		visible_query.assert_not_called()
		query.assert_called_once_with(
			"Warehouse",
			filters={"supplier": "HO", "disabled": 0, "is_group": 0},
			fields=["name"],
			limit_page_length=0,
			order_by="name",
		)
		get_doc.assert_called_once_with("Supplier", "HO")

	def test_head_office_denies_unreadable_sole_warehouse(self):
		self.database.get_value.return_value = "HO"
		supplier = SimpleNamespace(disabled=0, check_permission=Mock())
		warehouse = SimpleNamespace(check_permission=Mock(side_effect=frappe.PermissionError))
		with (
			patch("frappe.get_doc", side_effect=[supplier, warehouse]) as get_doc,
			patch("frappe.get_all", return_value=[frappe._dict(name="HO WH")]),
			patch("frappe.get_list", return_value=[frappe._dict(name="HO WH")]),
		):
			with self.assertRaises(frappe.PermissionError):
				get_head_office()
		get_doc.assert_called_with("Warehouse", "HO WH")
		warehouse.check_permission.assert_called_once_with("read")

	def test_location_property_and_manual_grn_share_head_office_owner(self):
		self.assertEqual(
			MGKPurchaseOrder.receipt_location.fget(self.order), {"location": "Own", "warehouse": "Own WH"}
		)
		self.order.deliver_to_supplier = 1
		with patch(
			f"{ORDER}.get_head_office", return_value={"location": "HO", "warehouse": "HO WH"}
		) as lookup:
			self.order.receipt_location = MGKPurchaseOrder.receipt_location.fget(self.order)
		lookup.assert_called_once_with()
		doc = SimpleNamespace(purchase_order="PO-1", warehouse=None)
		with patch("frappe.get_doc", return_value=self.order):
			MGKGoodsReceivedNote.validate_purchase_order(doc)
		self.assertEqual((doc.delivery_location, doc.warehouse), ("HO", "HO WH"))

	def test_permission_failure_happens_before_lock_savepoint_and_mapping(self):
		self.order.deliver_to_supplier = 1
		for denied in (
			("MGK Goods Received Note", "create"),
			("MGK Goods Received Note", "submit"),
			("MGK Delivery Challan", "create"),
			("MGK Delivery Challan", "submit"),
		):

			def permission(doctype, action, **kwargs):
				if (doctype, action) == denied:
					raise frappe.PermissionError

			with (
				self.subTest(denied=denied),
				patch("frappe.has_permission", side_effect=permission),
				patch(f"{FLOW}.lock_documents") as lock,
			):
				with self.assertRaises(frappe.PermissionError):
					PurchaseReceipt(self.order).submit()
				lock.assert_not_called()
		self.database.savepoint.assert_not_called()

	def test_po_read_permission_failure_precedes_target_permissions(self):
		self.order.check_permission.side_effect = frappe.PermissionError
		with patch("frappe.has_permission") as permission, self.assertRaises(frappe.PermissionError):
			PurchaseReceipt(self.order).submit()
		permission.assert_not_called()

	def test_lock_then_current_reload_blocks_a_stale_double_click(self):
		sequence = Mock()
		self.order.reload = sequence.reload

		def reload():
			self.assertTrue(self.order.flags.for_update)
			self.order.items[0].pending_qty = 0

		self.order.reload.side_effect = reload
		with (
			patch("frappe.has_permission"),
			patch(f"{FLOW}.lock_documents", sequence.lock),
			patch(f"{FLOW}.lock_stock_buckets") as buckets,
		):
			with self.assertRaisesRegex(frappe.ValidationError, "PO-1 is already fully received"):
				PurchaseReceipt(self.order).submit()
		buckets.assert_not_called()
		self.assertEqual(sequence.mock_calls, [call.lock({"MGK Purchase Order": ["PO-1"]}), call.reload()])
		self.database.savepoint.assert_not_called()

	def test_all_pending_stock_buckets_are_locked_in_order_before_grn_insert(self):
		for is_direct_delivery in (False, True):
			sequence = Mock()
			self.order.reload = sequence.reload
			self.order.deliver_to_supplier = is_direct_delivery
			self.order.warehouse = "A Job WH" if is_direct_delivery else "Own WH"
			receipt_warehouse = "Z HO WH" if is_direct_delivery else "Own WH"
			self.order.receipt_location = {"location": "Receipt", "warehouse": receipt_warehouse}
			self.order.items = [
				make_row(item="Zeta", pending_qty=4),
				make_row(item="Alpha", pending_qty=2, received_type="Accepted"),
				make_row(item="Alpha", pending_qty=1, received_type="Rejected"),
				make_row(item="Done", pending_qty=0),
				make_row(item="Overreceived", pending_qty=-1),
			]
			receipt = Mock()
			receipt.name = "GRN"
			receipt.insert.return_value = receipt
			sequence.attach_mock(receipt.insert, "grn_insert")
			sequence.attach_mock(receipt.submit, "grn_submit")
			flow = PurchaseReceipt(self.order)
			with (
				self.subTest(is_direct_delivery=is_direct_delivery),
				patch("frappe.has_permission"),
				patch("frappe.generate_hash", return_value="checkpoint"),
				patch(f"{FLOW}.lock_documents", sequence.lock),
				patch(f"{FLOW}.lock_stock_buckets", sequence.buckets),
				patch(f"{ORDER}.make_goods_received_note", return_value=receipt),
				patch.object(flow, "make_delivery_challan"),
			):
				flow.submit()
				buckets = (
					[("Alpha", "A Job WH"), ("Alpha", "Z HO WH"), ("Zeta", "A Job WH"), ("Zeta", "Z HO WH")]
					if is_direct_delivery
					else [("Alpha", "Own WH"), ("Zeta", "Own WH")]
				)
				self.assertEqual(
					sequence.mock_calls,
					[
						call.lock({"MGK Purchase Order": ["PO-1"]}),
						call.reload(),
						call.buckets(buckets),
						call.grn_insert(),
						call.grn_submit(),
					],
				)

	def test_failure_rolls_back_savepoint_and_reraises_without_commit(self):
		flow = PurchaseReceipt(self.order)
		with (
			patch("frappe.has_permission"),
			patch(f"{FLOW}.lock_documents"),
			patch(f"{FLOW}.lock_stock_buckets"),
			patch("frappe.generate_hash", return_value="checkpoint"),
			patch.object(flow, "submit_documents", side_effect=RuntimeError("DC failure")),
		):
			with self.assertRaisesRegex(RuntimeError, "DC failure"):
				flow.submit()
		self.database.savepoint.assert_called_once_with("purchase_receipt_checkpoint")
		self.database.rollback.assert_called_once_with(save_point="purchase_receipt_checkpoint")
		self.database.commit.assert_not_called()

	def test_permissions_are_rechecked_on_the_persisted_delivery_mode(self):
		def reload():
			self.order.deliver_to_supplier = 1

		self.order.reload.side_effect = reload

		def permission(doctype, action, **kwargs):
			if (doctype, action) == ("MGK Delivery Challan", "submit"):
				raise frappe.PermissionError

		with patch("frappe.has_permission", side_effect=permission), patch(f"{FLOW}.lock_documents"):
			with self.assertRaises(frappe.PermissionError):
				PurchaseReceipt(self.order).submit()
		self.database.savepoint.assert_not_called()

	def test_dc_source_validation_checks_both_links_and_submitted_receipt(self):
		doc = SimpleNamespace(purchase_order=None, goods_received_note=None, is_return=0)
		self.assertIsNone(MGKDeliveryChallan.validate_purchase_receipt(doc))
		receipt = EditorDocument(
			name="GRN",
			docstatus=1,
			against_purchase_order=1,
			purchase_order="PO",
			warehouse="HO WH",
			check_permission=Mock(),
		)
		for values in (
			{"purchase_order": None},
			{"goods_received_note": None},
			{"is_return": 1},
			{"purchase_order": "Other"},
			{"from_warehouse": "Other"},
		):
			doc = SimpleNamespace(
				purchase_order="PO", goods_received_note="GRN", is_return=0, from_warehouse="HO WH"
			)
			doc.__dict__.update(values)
			with self.subTest(values=values), patch("frappe.get_doc", return_value=receipt):
				with self.assertRaises(frappe.ValidationError):
					MGKDeliveryChallan.validate_purchase_receipt(doc)
		doc.from_warehouse = "HO WH"
		receipt.docstatus = 0
		with (
			patch("frappe.get_doc", return_value=receipt),
			self.assertRaisesRegex(frappe.ValidationError, "must be submitted"),
		):
			MGKDeliveryChallan.validate_purchase_receipt(doc)

	def test_linked_dc_rechecks_current_receipt_after_source_locks(self):
		doc = SimpleNamespace(
			purchase_order="PO", goods_received_note="GRN", is_return=0, from_warehouse="HO WH"
		)
		receipt = EditorDocument(
			name="GRN",
			docstatus=1,
			against_purchase_order=1,
			purchase_order="PO",
			warehouse="HO WH",
			check_permission=Mock(),
		)
		order = SimpleNamespace(check_permission=Mock())
		with patch("frappe.get_doc", side_effect=[receipt, order]) as get_doc:
			MGKDeliveryChallan.validate_purchase_receipt(doc, for_update=True)
		self.assertEqual(
			get_doc.call_args_list,
			[
				call("MGK Goods Received Note", "GRN", for_update=True),
				call("MGK Purchase Order", "PO"),
			],
		)
		receipt.check_permission.assert_called_once_with("read")
		order.check_permission.assert_called_once_with("read")

	def test_linked_dc_denies_unreadable_po_even_with_receipt_read_permission(self):
		doc = SimpleNamespace(
			purchase_order="PO", goods_received_note="GRN", is_return=0, from_warehouse="HO WH"
		)
		receipt = SimpleNamespace(
			name="GRN",
			docstatus=1,
			against_purchase_order=1,
			purchase_order="PO",
			warehouse="HO WH",
			check_permission=Mock(),
		)
		order = SimpleNamespace(check_permission=Mock(side_effect=frappe.PermissionError))
		with patch("frappe.get_doc", side_effect=[receipt, order]):
			with self.assertRaises(frappe.PermissionError):
				MGKDeliveryChallan.validate_purchase_receipt(doc)
		receipt.check_permission.assert_called_once_with("read")
		order.check_permission.assert_called_once_with("read")

	def test_mapper_uses_current_pending_rows_after_lock_even_with_old_source(self):
		current = self.order.items[0]
		current.pending_qty = 3
		self.order.receipt_location = {"location": "Own", "warehouse": "Own WH"}
		self.order.supplier = "Supplier"

		def mapper(doctype, name, maps, **kwargs):
			stale = make_row(name="PO-row", pending_qty=10)
			self.assertTrue(maps["MGK Purchase Order Item"]["condition"](stale))
			target = make_row(qty=10)
			maps["MGK Purchase Order Item"]["postprocess"](stale, target, self.order)
			self.assertEqual(target.qty, 3)
			current.pending_qty = 0
			self.assertFalse(maps["MGK Purchase Order Item"]["condition"](stale))
			return target

		with (
			patch("frappe.get_doc", return_value=self.order),
			patch(f"{ORDER}.get_mapped_doc", side_effect=mapper),
			patch(f"{ORDER}.copy_row_dimensions"),
		):
			make_goods_received_note("PO-1")

	def test_linked_dc_snapshot_uses_receipt_without_independent_resolution(self):
		source = make_row(name="GRN-row", item="Yarn", qty=2, received_type="Rejected")
		row = make_row(item="Yarn", qty=2, against_dc_item=None, received_type="Rejected")
		doc = SimpleNamespace(items=[row])
		with patch(f"{CHALLAN}.validate_return_dimensions"):
			MGKDeliveryChallan.set_purchase_receipt_rows(doc, SimpleNamespace(name="GRN", items=[source]))
		self.assertEqual((row.uom, row.conversion_factor, row.stock_qty), ("Bag", 50, 100))
		self.assertEqual((row.goods_received_note, row.goods_received_note_item), ("GRN", "GRN-row"))
		row.conversion_factor = 25
		with (
			patch(f"{CHALLAN}.validate_return_dimensions"),
			self.assertRaisesRegex(frappe.ValidationError, "different conversion_factor"),
		):
			MGKDeliveryChallan.set_purchase_receipt_rows(doc, SimpleNamespace(name="GRN", items=[source]))

	def test_linked_dc_dimension_mismatch_names_the_receipt(self):
		source = make_row(name="GRN-row", received_type="Rejected")
		row = make_row(received_type="Accepted", against_dc_item=None)
		with patch(
			"mgk_yrp.stock.dimensions.get_stock_dimensions",
			return_value=[{"fieldname": "received_type", "label": "Received Type"}],
		):
			with self.assertRaisesRegex(
				frappe.ValidationError, "Received Type must match the original Goods Received Note row"
			):
				MGKDeliveryChallan.set_purchase_receipt_rows(
					SimpleNamespace(items=[row]), SimpleNamespace(name="GRN", items=[source])
				)

	def test_source_locks_include_po_then_dc_then_grn(self):
		doc = EditorDocument(
			docstatus=0,
			purchase_order="PO",
			goods_received_note="GRN",
			return_against=None,
			name="DC",
			items=[],
			get_doc_before_save=lambda: None,
		)
		with patch(f"{CHALLAN}.lock_documents") as lock:
			MGKDeliveryChallan.lock_sources(doc)
		lock.assert_called_once_with(
			{
				"MGK Purchase Order": ["PO", None],
				"MGK Delivery Challan": [None, None, "DC"],
				"MGK Goods Received Note": ["GRN"],
			},
		)
