from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, nowdate
from yrp.stock.uom import resolve_item_uom
from yrp.stock.utils import get_stock_balance

from mgk_yrp.job_work import dc_from_grn
from mgk_yrp.stock.item_editor import get_item_details
from mgk_yrp.stock.ledger import assert_transfer_pairs, get_voucher_sles
from mgk_yrp.tests.fixtures import (
	close_dc,
	make_delivery_challan,
	make_item,
	make_job_work_grn,
	make_po_grn,
	make_process,
	make_purchase_order,
	make_received_type,
	make_return,
	make_supplier,
	make_uom,
	make_warehouse,
	run_adjustments,
)


class TestDispatchFromReceipt(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.enterContext(patch("frappe.enqueue"))
		self.location = make_supplier(is_company_location=1)
		self.warehouse = make_warehouse(supplier=self.location)
		self.supplier = make_supplier()
		self.worker = make_supplier()
		self.destination = make_warehouse(supplier=self.worker)
		self.process = make_process()
		self.item = make_item(stock_uom=make_uom("Kg"))

	def receipt(self, *, warehouse=None, items=None):
		receipt = make_job_work_grn(
			supplier=self.supplier, warehouse=warehouse or self.warehouse,
			items=items or [{"item": self.item, "qty": 10, "rate": 12}], submit=False,
		)
		receipt.delivery_location = frappe.db.get_value("Warehouse", receipt.warehouse, "supplier")
		return receipt.save().submit()

	def dispatch(self, receipts, *, move=False):
		return dc_from_grn.make_delivery_challan_from_grns(
			[receipt.name for receipt in receipts], self.process, self.worker, int(move)
		)

	def partial(self, receipt, quantities):
		items = []
		for quantity in quantities:
			source = receipt.items[0]
			items.append({
				"item": source.item, "qty": quantity, "rate": source.rate,
				"goods_received_note": receipt.name, "goods_received_note_item": source.name,
			})
		return make_delivery_challan(
			from_warehouse=receipt.warehouse, to_supplier=self.worker, to_warehouse=self.destination,
			process_name=self.process, items=items, submit=False,
		)

	def head_office(self):
		frappe.db.set_value("Supplier", {"mgk_is_head_office": 1}, "mgk_is_head_office", 0)
		location = make_supplier(is_company_location=1)
		frappe.get_doc("Supplier", location).update({"mgk_is_head_office": 1}).save()
		return location, make_warehouse(supplier=location)

	def test_single_dispatch_preserves_rows_and_transfer_pairs(self):
		receipt = self.receipt(items=[
			{"item": self.item, "qty": 6, "rate": 12, "received_type": make_received_type("Accepted")},
			{"item": self.item, "qty": 4, "rate": 0, "received_type": make_received_type("Rejected")},
		])
		result = self.dispatch([receipt])
		challan = frappe.get_doc("MGK Delivery Challan", result["delivery_challan"])
		self.assertEqual(challan.docstatus, 1)
		self.assertEqual((challan.from_location, challan.from_warehouse), (self.location, self.warehouse))
		self.assertEqual((challan.to_location, challan.process_name), (self.worker, self.process))
		self.assertEqual(result["stock_entries"], [])
		for row, source in zip(challan.items, receipt.items, strict=True):
			self.assertEqual((row.goods_received_note, row.goods_received_note_item), (receipt.name, source.name))
			self.assertEqual((row.qty, row.rate, row.received_type), (source.qty, source.rate, source.received_type))
		assert_transfer_pairs(challan.doctype, challan.name, expected_entries=challan.get_stock_entries())

	def test_receipt_link_fields_are_read_only_and_not_copied(self):
		meta = frappe.get_meta("MGK Delivery Challan Item")
		for name in ("goods_received_note", "goods_received_note_item"):
			field = meta.get_field(name)
			self.assertTrue(field.read_only)
			self.assertTrue(field.no_copy)
		field = frappe.get_meta("YRP Stock Entry").get_field("mgk_delivery_challan")
		self.assertEqual(field.options, "MGK Delivery Challan")
		self.assertTrue(field.read_only)
		self.assertTrue(field.no_copy)

	def test_second_dispatch_gets_remainder_only(self):
		receipt = self.receipt()
		self.partial(receipt, [4]).submit()
		result = self.dispatch([receipt, receipt])
		challan = frappe.get_doc("MGK Delivery Challan", result["delivery_challan"])
		self.assertEqual([row.qty for row in challan.items], [6])
		self.assertEqual(dc_from_grn.get_dispatched_quantities([receipt.name])[receipt.items[0].name], 10)

	def test_fully_dispatched_grn_rejects_create_dc(self):
		receipt = self.receipt()
		self.dispatch([receipt])
		with self.assertRaisesRegex(frappe.ValidationError, "no remaining quantity"):
			self.dispatch([receipt])

	def test_duplicate_rows_cannot_exceed_remaining(self):
		receipt = self.receipt()
		challan = self.partial(receipt, [6, 6])
		with self.assertRaisesRegex(frappe.ValidationError, "quantity exceeds what is left"):
			challan.submit()

	def test_bulk_requires_shared_warehouse_without_move(self):
		first, second = self.receipt(), self.receipt()
		result = self.dispatch([first, second])
		self.assertEqual(len(frappe.get_doc("MGK Delivery Challan", result["delivery_challan"]).items), 2)
		other = make_warehouse(supplier=make_supplier(is_company_location=1))
		with self.assertRaisesRegex(frappe.ValidationError, "tick Move stock to Head Office"):
			self.dispatch([self.receipt(), self.receipt(warehouse=other)])

	def test_editor_round_trip_preserves_receipt_links(self):
		receipt = self.receipt()
		challan = self.partial(receipt, [4])
		challan.item_details = frappe.as_json(get_item_details(challan))
		challan.save().submit()
		self.assertEqual(challan.items[0].goods_received_note, receipt.name)
		self.assertEqual(challan.items[0].goods_received_note_item, receipt.items[0].name)

	def test_row_linked_dispatch_blocks_receipt_cancel(self):
		receipt = self.receipt()
		result = self.dispatch([receipt])
		with self.assertRaisesRegex(frappe.ValidationError, f"Cancel Delivery Challan {result['delivery_challan']} before this receipt"):
			receipt.cancel()

	def test_head_office_moves_cancel_with_dispatch(self):
		location, warehouse = self.head_office()
		other = make_warehouse(supplier=make_supplier(is_company_location=1))
		receipts = [self.receipt(), self.receipt(warehouse=other)]
		result = self.dispatch(receipts, move=True)
		challan = frappe.get_doc("MGK Delivery Challan", result["delivery_challan"])
		self.assertEqual((challan.from_location, challan.from_warehouse), (location, warehouse))
		self.assertEqual(len(result["stock_entries"]), 2)
		for name in result["stock_entries"]:
			entry = frappe.get_doc("YRP Stock Entry", name)
			self.assertEqual((entry.docstatus, entry.purpose, entry.skip_transit), (1, "Send to Warehouse", 1))
			self.assertEqual(entry.mgk_delivery_challan, challan.name)
			assert_transfer_pairs(entry.doctype, name, expected_entries=entry.get_sl_entries())
			with self.assertRaisesRegex(frappe.ValidationError, f"Cancel Delivery Challan {challan.name} first"):
				entry.cancel()
		challan.reload().cancel()
		self.assertEqual([frappe.db.get_value("YRP Stock Entry", name, "docstatus") for name in result["stock_entries"]], [2, 2])
		for receipt in receipts:
			self.assertEqual(get_stock_balance(self.item, receipt.warehouse), 10)
			receipt.reload().cancel()

	def test_dc_failure_rolls_back_head_office_move(self):
		self.head_office()
		receipt = self.receipt()
		def fail(_document):
			frappe.throw("Dispatch failed")
		with patch("mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan.MGKDeliveryChallan.before_submit", fail):
			with self.assertRaisesRegex(frappe.ValidationError, "Dispatch failed"):
				self.dispatch([receipt], move=True)
		self.assertFalse(dc_from_grn.get_linking_challans([receipt.name]))
		self.assertFalse(frappe.db.exists("YRP Stock Entry", {"from_warehouse": receipt.warehouse}))
		self.assertEqual(get_stock_balance(self.item, receipt.warehouse), 10)

	def test_wrong_item_dimension_and_uom_rejected(self):
		receipt = self.receipt()
		changes = {
			"item": make_item(stock_uom="Kg"),
			"received_type": make_received_type("Rejected"),
			"uom": make_uom("Nos"),
			"conversion_factor": 2,
		}
		for field, value in changes.items():
			with self.subTest(field=field):
				challan = self.partial(receipt, [4])
				challan.items[0].set(field, value)
				with self.assertRaises(frappe.ValidationError):
					challan.save()

	def test_source_row_must_belong_to_named_receipt(self):
		first, second = self.receipt(), self.receipt()
		challan = self.partial(first, [4])
		challan.items[0].goods_received_note_item = second.items[0].name
		with self.assertRaisesRegex(frappe.ValidationError, "Item must map to a row of this Goods Received Note"):
			challan.save()

	def test_source_locks_include_old_and_new_receipts_in_one_call(self):
		first, second = self.receipt(), self.receipt()
		challan = self.partial(first, [4])
		previous = frappe.get_doc(challan.doctype, challan.name)
		challan.items[0].goods_received_note = second.name
		challan.items[0].goods_received_note_item = second.items[0].name
		with patch("mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan.lock_documents") as locks:
			challan.lock_sources(previous=previous)
		locks.assert_called_once()
		documents = locks.call_args.args[0]
		self.assertEqual(set(documents["MGK Goods Received Note"]), {first.name, second.name})
		self.assertIn(challan.name, documents["MGK Delivery Challan"])

	def test_return_and_cancelled_challans_do_not_increase_dispatch(self):
		receipt = self.receipt()
		challan = self.partial(receipt, [4]).submit()
		returned = make_return(challan, {challan.items[0].name: 2})
		self.assertEqual(dc_from_grn.get_dispatched_quantities([receipt.name])[receipt.items[0].name], 4)
		returned.cancel()
		challan.reload().cancel()
		self.assertEqual(dc_from_grn.get_dispatched_quantities([receipt.name])[receipt.items[0].name], 0)

	def test_header_linked_dispatch_uses_same_allowance(self):
		order = make_purchase_order(
			supplier=self.supplier, warehouse=self.warehouse,
			items=[{"item": self.item, "qty": 10, "rate": 12}],
		)
		receipt = make_po_grn(order)
		self.partial(receipt, [4]).submit()
		challan = make_delivery_challan(
			from_warehouse=self.warehouse, to_supplier=self.worker, to_warehouse=self.destination,
			items=[{"item": self.item, "qty": 10, "rate": 12}], process_name=self.process,
			purchase_order=order.name, goods_received_note=receipt.name, submit=False,
		)
		with self.assertRaisesRegex(frappe.ValidationError, "quantity exceeds what is left"):
			challan.submit()

	def test_moved_warehouse_requires_covering_stock_entry(self):
		location, warehouse = self.head_office()
		receipt = self.receipt()
		challan = self.partial(receipt, [4])
		challan.from_location, challan.from_warehouse = location, warehouse
		challan.save()
		with self.assertRaisesRegex(frappe.ValidationError, f"stock of Goods Received Note {receipt.name} is not at"):
			challan.submit()

	def test_po_receipt_can_be_dispatched(self):
		order = make_purchase_order(
			supplier=self.supplier, warehouse=self.warehouse,
			items=[{"item": self.item, "qty": 10, "rate": 12}],
		)
		receipt = make_po_grn(order)
		result = self.dispatch([receipt])
		self.assertEqual(frappe.db.get_value("MGK Delivery Challan", result["delivery_challan"], "docstatus"), 1)

	def test_company_location_or_disabled_supplier_rejected(self):
		receipt = self.receipt()
		for field in ("disabled", "is_company_location"):
			with self.subTest(field=field):
				frappe.db.set_value("Supplier", self.worker, field, 1)
				with self.assertRaisesRegex(frappe.ValidationError, "enabled supplier"):
					self.dispatch([receipt])
				frappe.db.set_value("Supplier", self.worker, field, 0)

	def test_internal_and_draft_receipts_rejected(self):
		draft = make_job_work_grn(
			supplier=self.supplier, warehouse=self.warehouse,
			items=[{"item": self.item, "qty": 10, "rate": 12}], submit=False,
		)
		with self.assertRaisesRegex(frappe.ValidationError, "must be submitted"):
			self.dispatch([draft])
		receipt = self.receipt()
		receipt.db_set("is_internal_transfer", 1)
		with self.assertRaisesRegex(frappe.ValidationError, "internal transfer"):
			self.dispatch([receipt])
		receipt.db_set("is_internal_transfer", 0)
		receipt.cancel()
		with self.assertRaisesRegex(frappe.ValidationError, "must be submitted"):
			self.dispatch([receipt])

	def test_dispatch_permissions_checked_before_creating_documents(self):
		receipt = self.receipt()
		self.head_office()
		original = frappe.has_permission
		for denied in ("MGK Delivery Challan", "YRP Stock Entry"):
			def permission(doctype=None, ptype="read", **kwargs):
				if doctype == denied and ptype == "submit":
					frappe.throw("Dispatch submit denied", frappe.PermissionError)
				return original(doctype, ptype, **kwargs)
			with self.subTest(doctype=denied), patch("frappe.has_permission", side_effect=permission):
				with self.assertRaises(frappe.PermissionError):
					self.dispatch([receipt], move=True)
			self.assertFalse(dc_from_grn.get_linking_challans([receipt.name]))
			self.assertFalse(frappe.db.exists("YRP Stock Entry", {"from_warehouse": receipt.warehouse}))

	def test_dispatch_locks_existing_challans_before_receipts(self):
		from mgk_yrp.stock.locking import lock_documents

		receipt = self.receipt()
		challan = self.partial(receipt, [4]).submit()
		service = dc_from_grn.JobWorkDispatch([receipt], self.process, self.worker, False)
		with patch("mgk_yrp.stock.dependencies.lock_documents", wraps=lock_documents) as locks:
			service.lock_sources()
		locks.assert_called_once()
		documents = locks.call_args.args[0]
		self.assertIn(challan.name, documents["MGK Delivery Challan"])
		self.assertIn(receipt.name, documents["MGK Goods Received Note"])

	def test_changed_dispatch_dependencies_require_retry(self):
		receipt = self.receipt()
		with patch.object(dc_from_grn, "get_linking_challans", side_effect=[[], ["new-challan"]]):
			with self.assertRaisesRegex(frappe.ValidationError, "Stock dependencies changed; retry the operation"):
				self.dispatch([receipt])
		self.assertFalse(dc_from_grn.get_linking_challans([receipt.name]))

	def test_grn_read_permission_is_required(self):
		from frappe.permissions import has_permission

		receipt = self.receipt()
		def permission(doctype=None, ptype="read", doc=None, **kwargs):
			if doctype == "MGK Goods Received Note" and ptype == "read":
				frappe.throw("Receipt read denied", frappe.PermissionError)
			return has_permission(doctype, ptype, doc, **kwargs)
		with patch("frappe.permissions.has_permission", side_effect=permission):
			with self.assertRaises(frappe.PermissionError):
				self.dispatch([receipt])
		self.assertFalse(dc_from_grn.get_linking_challans([receipt.name]))

	def test_head_office_receipt_needs_no_stock_entry(self):
		_location, warehouse = self.head_office()
		receipt = self.receipt(warehouse=warehouse)
		result = self.dispatch([receipt], move=True)
		self.assertEqual(result["stock_entries"], [])
		self.assertEqual(frappe.db.get_value("MGK Delivery Challan", result["delivery_challan"], "from_warehouse"), warehouse)

	def test_missing_head_office_rejected_before_writes(self):
		frappe.db.set_value("Supplier", {"mgk_is_head_office": 1}, "mgk_is_head_office", 0)
		receipt = self.receipt()
		with self.assertRaisesRegex(frappe.ValidationError, "Set Is Head Office"):
			self.dispatch([receipt], move=True)
		self.assertFalse(dc_from_grn.get_linking_challans([receipt.name]))

	def test_uom_snapshot_survives_master_change(self):
		self.head_office()
		item = make_item(stock_uom="Kg", purchase_uom=make_uom("Box"), conversion_factor=10)
		receipt = self.receipt(items=[{"item": item, "qty": 2, "rate": 120}])
		parent = frappe.db.get_value("Item", item, "variant_of")
		frappe.db.set_value("UOM Conversion Detail", {"parent": parent, "uom": "Box"}, "conversion_factor", 12)
		frappe.clear_document_cache("Item", parent)
		self.assertEqual(resolve_item_uom(item).conversion_factor, 12)
		result = self.dispatch([receipt], move=True)
		for doctype, name in (("MGK Delivery Challan", result["delivery_challan"]), ("YRP Stock Entry", result["stock_entries"][0])):
			row = frappe.get_doc(doctype, name).items[0]
			self.assertEqual((row.uom, row.conversion_factor, row.stock_qty), ("Box", 10, 20))
			self.assertEqual({abs(entry.qty) for entry in get_voucher_sles(doctype, name)}, {20})

	def test_future_movement_prevents_deferred_head_office_move(self):
		_location, head_office = self.head_office()
		for warehouse in (self.warehouse, head_office):
			receipt = self.receipt()
			future = make_job_work_grn(
				supplier=self.supplier, warehouse=warehouse,
				items=[{"item": self.item, "qty": 10, "rate": 12}], submit=False,
			)
			future.edit_posting_date_and_time = 1
			future.posting_date = add_days(nowdate(), 1)
			future.save().submit()
			with self.assertRaisesRegex(frappe.ValidationError, "Resolve future stock entry"):
				self.dispatch([receipt], move=True)
			self.assertFalse(dc_from_grn.get_linking_challans([receipt.name]))
			self.assertFalse(frappe.db.exists("YRP Stock Entry", {"from_warehouse": receipt.warehouse}))
			future.cancel()

	def test_head_office_moves_post_inline(self):
		self.head_office()
		receipt = self.receipt()
		with patch("yrp.stock.stock_ledger._enqueue_backdated_repost") as queued:
			result = self.dispatch([receipt], move=True)
		queued.assert_not_called()
		entry = frappe.get_doc("YRP Stock Entry", result["stock_entries"][0])
		self.assertEqual({row.warehouse for row in get_voucher_sles(entry.doctype, entry.name)}, {self.warehouse, entry.to_warehouse})

	def test_head_office_move_posting_time_cannot_be_edited(self):
		self.head_office()
		receipt = self.receipt()
		service = dc_from_grn.JobWorkDispatch([receipt], self.process, self.worker, True)
		service.lock_sources()
		service.validate()
		challan = service.make_delivery_challan().insert()
		with patch("yrp.yrp_stock.doctype.yrp_stock_entry.yrp_stock_entry.YRPStockEntry.submit", lambda entry: entry):
			name = service.move_stock(challan)[0]
		entry = frappe.get_doc("YRP Stock Entry", name)
		dc_from_grn.validate_head_office_move_entry(entry, "validate")
		entry.posting_date = add_days(nowdate(), -1)
		with self.assertRaisesRegex(frappe.ValidationError, "cannot be edited"):
			dc_from_grn.validate_head_office_move_entry(entry, "before_submit")

	def test_upstream_reversal_blocks_dispatch_until_finished(self):
		receipt = self.receipt()
		upstream = self.partial(receipt, [10]).submit()
		output_warehouse = make_warehouse(supplier=make_supplier(is_company_location=1))
		output = make_job_work_grn(
			supplier=self.worker, warehouse=output_warehouse, delivery_challans=[upstream.name],
			items=[{"item": self.item, "qty": 10, "rate": 2}],
		)
		close = close_dc(upstream)
		run_adjustments(close.doctype, close.name)
		with self.assertRaisesRegex(frappe.ValidationError, "is closed; reopen"):
			output.cancel()
		close.reload().cancel()
		with self.assertRaisesRegex(frappe.ValidationError, "Finish reopening Close"):
			self.dispatch([output])
		with self.assertRaisesRegex(frappe.ValidationError, "is closed; reopen"):
			output.reload().cancel()
		run_adjustments(close.doctype, close.name)
		from mgk_yrp.job_work.reopen import finish_reopen

		self.assertTrue(finish_reopen(close.name))
		result = self.dispatch([output])
		with self.assertRaisesRegex(frappe.ValidationError, "Cancel Delivery Challan"):
			output.reload().cancel()
		frappe.get_doc("MGK Delivery Challan", result["delivery_challan"]).cancel()
		output.reload().cancel()
