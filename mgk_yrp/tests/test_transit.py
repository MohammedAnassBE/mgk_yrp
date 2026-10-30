from unittest.mock import patch

import frappe
from frappe.model.document import Document
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, nowdate
from yrp.stock.uom import resolve_item_uom
from yrp.stock.utils import get_stock_balance

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import (
	make_return_delivery_challan,
)
from mgk_yrp.stock import transit
from mgk_yrp.stock.ledger import assert_transfer_pairs, get_voucher_sles
from mgk_yrp.tests.fixtures import (
	close_dc,
	dimensioned_items,
	make_delivery_challan,
	make_item,
	make_job_work_grn,
	make_po_grn,
	make_purchase_invoice,
	make_purchase_order,
	make_return,
	make_supplier,
	make_uom,
	make_warehouse,
	run_adjustments,
)


class TestTransit(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		previous = frappe.db.get_single_value("YRP Stock Settings", "transit_warehouse", cache=False)
		# Cleanups run LIFO: roll back test records before restoring settings and cache.
		self.addCleanup(self.set_transit, previous)
		self.addCleanup(frappe.db.rollback)
		self.enterContext(patch("frappe.enqueue"))
		self.origin, self.destination = [make_supplier(is_company_location=1) for _ in range(2)]
		self.vendor = make_supplier()
		self.main = make_warehouse(supplier=self.origin)
		self.receiving, self.second = [make_warehouse(supplier=self.destination) for _ in range(2)]
		self.transit = make_warehouse()
		self.set_transit(self.transit)
		self.item = make_item(stock_uom=make_uom("Kg"))

	def set_transit(self, warehouse):
		frappe.db.set_single_value("YRP Stock Settings", "transit_warehouse", warehouse)
		frappe.clear_document_cache("YRP Stock Settings", "YRP Stock Settings")

	def save_transit_setting(self, warehouse):
		settings = frappe.get_single("YRP Stock Settings")
		settings.transit_warehouse = warehouse
		# Both the controller and MGK hook sync schema and can commit test records.
		with (
			patch("yrp.stock.dimensions.create_dimension_fields", autospec=True, return_value=None),
			patch("mgk_yrp.stock.dimension_fields.sync_dimension_fields", autospec=True, return_value=None),
		):
			settings.save()

	def test_f8_settings_save_preserves_transaction(self):
		checkpoint = "transit_settings_save"
		frappe.db.savepoint(checkpoint)
		self.save_transit_setting(self.second)
		self.assertEqual(
			frappe.db.get_single_value("YRP Stock Settings", "transit_warehouse", cache=False), self.second
		)
		frappe.db.rollback(save_point=checkpoint)
		frappe.db.release_savepoint(checkpoint)
		self.assertEqual(
			frappe.db.get_single_value("YRP Stock Settings", "transit_warehouse", cache=False), self.transit
		)
		frappe.clear_document_cache("YRP Stock Settings", "YRP Stock Settings")

	def make_receipt(self, *, internal=True, item=None, submit=True):
		order = make_purchase_order(
			supplier=self.vendor,
			warehouse=self.receiving,
			items=[{"item": item or self.item, "qty": 10, "rate": 100}],
		)
		if internal:
			# Legacy submitted POs can still have company-location suppliers.
			frappe.db.set_value(order.doctype, order.name, "supplier", self.origin)
			order.reload()
		return make_po_grn(order, submit=submit)

	def make_challan(self, *, internal=True, item=None, submit=True, **header):
		order = make_purchase_order(
			supplier=self.vendor, warehouse=self.main,
			items=[{"item": item or self.item, "qty": 10, "rate": 100}],
		)
		make_po_grn(order)
		destination = self.destination if internal else self.vendor
		warehouse = self.receiving if internal else make_warehouse(supplier=destination)
		return make_delivery_challan(
			from_warehouse=self.main, to_supplier=destination, to_warehouse=warehouse,
			items=[{"item": item or self.item, "qty": 10}], submit=submit, **header,
		)

	def complete(self, source, quantity=10, warehouse=None):
		name = transit.complete_transfer(source.doctype, source.name, warehouse or self.receiving,
			[{"name": source.items[0].name, "qty": quantity}])
		return frappe.get_doc("YRP Stock Entry", name)

	def draft_completion(self, source, quantity=10):
		entry = frappe.new_doc("YRP Stock Entry")
		entry.update({"purpose": transit.SOURCES[source.doctype][0], "against": source.doctype,
			"against_id": source.name, "from_warehouse": self.transit, "to_warehouse": self.receiving})
		transit.append_completion_row(entry, source, {"name": source.items[0].name, "qty": quantity})
		return entry

	def balance(self, warehouse, item=None):
		return get_stock_balance(item or self.item, warehouse)

	def assert_status(self, source, status, quantity):
		source.reload()
		self.assertEqual(source.transfer_status, status)
		self.assertEqual(source.items[0].transferred_qty, quantity)

	def test_t1_flags_recomputed_and_returns_excluded(self):
		source = self.make_challan(submit=False)
		self.assertEqual(source.is_internal_transfer, 1)
		for origin, destination, is_return, expected in (
			(self.origin, self.origin, 0, 0), (self.vendor, self.destination, 0, 0),
			(self.origin, self.destination, 1, 0), (self.origin, self.destination, 0, 1),
		):
			source.from_location, source.to_location, source.is_return = origin, destination, is_return
			transit.set_internal_transfer(source)
			self.assertEqual(source.is_internal_transfer, expected)
		receipt = self.make_receipt(submit=False)
		self.assertEqual(receipt.is_internal_transfer, 1)
		frappe.db.set_value("Supplier", self.origin, "is_company_location", 0)
		receipt.submit()
		self.assertEqual(receipt.is_internal_transfer, 0)

	def test_t2_internal_dc_posts_paired_transit_and_has_no_open_status(self):
		source = self.make_challan()
		self.assertEqual({row.warehouse for row in get_voucher_sles(source.doctype, source.name)},
			{self.main, self.transit})
		assert_transfer_pairs(source.doctype, source.name, expected_entries=source.get_stock_entries())
		self.assertFalse(source.close_status)
		self.assertEqual((self.balance(self.main), self.balance(self.transit), self.balance(self.receiving)),
			(0, 10, 0))

	def test_t3_internal_grn_posts_transit_at_existing_rate_and_updates_po(self):
		source = self.make_receipt()
		entry = get_voucher_sles(source.doctype, source.name)[0]
		self.assertEqual((entry.warehouse, entry.qty, entry.rate), (self.transit, 10, 100))
		self.assertEqual(frappe.get_doc("MGK Purchase Order", source.purchase_order).status, "Completed")

	def test_t4_missing_transit_prevents_both_submissions(self):
		for factory in (self.make_challan, self.make_receipt):
			source = factory(submit=False)
			self.set_transit(None)
			with self.assertRaisesRegex(frappe.ValidationError, "Set Transit Warehouse in YRP Stock Settings"):
				source.submit()
			self.assertFalse(get_voucher_sles(source.doctype, source.name))
			self.set_transit(self.transit)

	def test_t5_t9_t10_partial_completions_to_two_warehouses_and_standalone_cancel(self):
		for factory in (self.make_challan, self.make_receipt):
			source = factory()
			self.assert_status(source, "In Transit", 0)
			first = self.complete(source, 6)
			self.assert_status(source, "Partly Transferred", 6)
			second = self.complete(source, 4, self.second)
			self.assert_status(source, "Transferred", 10)
			self.assertEqual((first.docstatus, second.docstatus), (1, 1))
			self.assertEqual((first.against, first.against_id, first.items[0].against,
				first.items[0].against_id_detail),
				(source.doctype, source.name, transit.SOURCES[source.doctype][1], source.items[0].name))
			second.cancel()
			self.assert_status(source, "Partly Transferred", 6)
			first.cancel()
			self.assert_status(source, "In Transit", 0)

	def test_t6_permissions_draft_noninternal_invalid_type_and_quantities(self):
		source = self.make_receipt()
		with patch("frappe.has_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				self.complete(source)
		with patch.object(Document, "check_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				self.complete(source)
		for quantity in (0, -1, 11):
			with self.subTest(quantity=quantity), self.assertRaises(frappe.ValidationError):
				self.complete(source, quantity)
		for invalid in (self.make_receipt(submit=False), self.make_receipt(internal=False)):
			with self.assertRaisesRegex(frappe.ValidationError, "submitted internal transfer"):
				self.complete(invalid)
		with self.assertRaises(frappe.ValidationError):
			transit.complete_transfer("Item", self.item, self.receiving, [])

	def test_t6_destination_must_be_enabled_leaf_at_destination(self):
		source = self.make_receipt()
		for field in ("disabled", "is_group"):
			frappe.db.set_value("Warehouse", self.second, field, 1)
			with self.assertRaisesRegex(frappe.ValidationError, "enabled and non-group"):
				self.complete(source, warehouse=self.second)
			frappe.db.set_value("Warehouse", self.second, field, 0)
		with self.assertRaisesRegex(frappe.ValidationError, "destination location"):
			self.complete(source, warehouse=self.main)

	def test_t7_zero_valuation_completes_without_warning(self):
		source = make_job_work_grn(supplier=self.origin, warehouse=self.receiving,
			items=[{"item": self.item, "qty": 10, "rate": 0}], submit=False)
		source.delivery_location = self.destination
		source.save().submit()
		with patch("frappe.msgprint") as message:
			entry = self.complete(source)
		self.assertEqual(entry.items[0].allow_zero_valuation_rate, 1)
		self.assertTrue(all(row.rate == 0 for row in get_voucher_sles(entry.doctype, entry.name)))
		self.assertFalse(any(call.kwargs.get("indicator") == "orange" for call in message.call_args_list))

	def test_t8_r7_handmade_completion_aggregates_duplicates_and_rechecks_submit(self):
		source = self.make_receipt()
		entry = self.draft_completion(source, 6)
		transit.append_completion_row(entry, source, {"name": source.items[0].name, "qty": 6})
		with self.assertRaisesRegex(frappe.ValidationError, "exceeds the pending"):
			entry.insert()
		draft = self.draft_completion(source, 6).insert()
		self.complete(source, 5)
		with self.assertRaisesRegex(frappe.ValidationError, "exceeds the pending"):
			draft.submit()

	def test_r7_duplicate_rows_within_pending_are_counted_together(self):
		source = self.make_receipt()
		entry = self.draft_completion(source, 3)
		transit.append_completion_row(entry, source, {"name": source.items[0].name, "qty": 2})
		entry.insert().submit()
		self.assert_status(source, "Partly Transferred", 5)
		self.assertEqual(self.balance(self.receiving), 5)
		entry.cancel()
		self.assert_status(source, "In Transit", 0)

	def test_r7_rejects_wrong_purpose_parent_child_item_and_dimensions(self):
		source = self.make_receipt()
		foreign = self.make_receipt()
		other_item = make_item(stock_uom="Kg")
		for field, value in (("purpose", "DC Completion"), ("against", "MGK Delivery Challan"),
			("against_id_detail", foreign.items[0].name), ("item", other_item),
			("from_warehouse", self.main)):
			entry = self.draft_completion(source)
			target = entry if field in ("purpose", "against", "from_warehouse") else entry.items[0]
			target.set(field, value)
			with self.subTest(field=field), self.assertRaises(frappe.ValidationError):
				entry.insert()
		entry = self.draft_completion(source)
		entry.items[0].against = "MGK Delivery Challan Item"
		with self.assertRaises(frappe.ValidationError):
			entry.insert()
		from yrp.stock.dimensions import get_dimension_fieldnames

		for field in get_dimension_fieldnames():
			entry = self.draft_completion(source)
			entry.items[0].set(field, None if source.items[0].get(field) else "foreign")
			with self.assertRaises(frappe.ValidationError):
				transit.validate_completion(entry)

	def test_t11_r5_r9_cancel_chain_newest_first_reverses_all_stock(self):
		for factory in (self.make_challan, self.make_receipt):
			source = factory()
			first, second = self.complete(source, 6), self.complete(source, 4, self.second)
			cancelled = []
			original = Document.cancel

			def record(document):
				if document.doctype == "YRP Stock Entry":
					cancelled.append(document.name)
				return original(document)

			with patch.object(Document, "cancel", record):
				source.cancel()
			self.assertEqual(cancelled, [second.name, first.name])
			self.assertEqual((first.reload().docstatus, second.reload().docstatus), (2, 2))
			self.assertFalse(source.reload().transfer_status)
			self.assertEqual(source.items[0].transferred_qty, 0)
			self.assertFalse(get_voucher_sles(source.doctype, source.name))
			self.assertEqual((self.balance(self.transit), self.balance(self.receiving), self.balance(self.second)),
				(0, 0, 0))

	def test_t11_consumed_stock_blocks_cancel_without_changes(self):
		source = self.make_receipt()
		completion = self.complete(source, 6)
		second = self.complete(source, 4, self.second)
		frappe.get_doc({"doctype": "YRP Stock Entry", "purpose": "Material Issue",
			"from_warehouse": self.receiving,
			"items": dimensioned_items([{"item": self.item, "qty": 6}]),
		}).insert().submit()
		with patch("frappe.get_roles", return_value=["Stock Manager"]), self.assertRaisesRegex(
			frappe.ValidationError, "Insufficient stock"
		):
			source.cancel()
		self.assertEqual((source.reload().docstatus, completion.reload().docstatus), (1, 1))
		self.assertEqual((second.reload().docstatus, self.balance(self.second)), (1, 4))
		self.assert_status(source, "Transferred", 10)

	def test_t12_internal_dc_rejects_close_and_grn_link_even_when_complete(self):
		source = self.make_challan()
		for completed in (False, True):
			if completed:
				self.complete(source)
			for action in (lambda: close_dc(source),
				lambda: make_job_work_grn(supplier=self.destination, warehouse=self.main,
					items=[{"item": self.item, "qty": 1}], delivery_challans=[source.name])):
				with self.assertRaisesRegex(frappe.ValidationError, "is an internal transfer"):
					action()

	def test_u1_u2_u4_partial_return_then_complete_remaining(self):
		source = self.make_challan()
		returned = make_return(source, {source.items[0].name: 4})
		self.assertEqual((returned.from_location, returned.from_warehouse, returned.to_location,
			returned.to_warehouse, returned.process_name, returned.is_internal_transfer),
			(self.destination, self.transit, self.origin, self.main, source.process_name, 0))
		self.assert_status(source, "Partly Transferred", 0)
		self.assertEqual(source.items[0].returned_qty, 4)
		self.assertEqual(make_return_delivery_challan(source.name).items[0].qty, 6)
		self.complete(source, 6)
		self.assert_status(source, "Transferred", 6)
		with self.assertRaisesRegex(frappe.ValidationError, "no remaining quantity"):
			make_return_delivery_challan(source.name)

	def test_u1_mapping_omits_rows_already_transferred(self):
		source = self.make_challan(submit=False)
		source.items[0].qty = 4
		second = source.items[0].as_dict()
		second.pop("name")
		second["qty"] = 6
		source.append("items", second)
		source.save().submit()
		self.complete(source, 4)
		returned = make_return_delivery_challan(source.name)
		self.assertEqual([(row.against_dc_item, row.qty) for row in returned.items], [(source.items[1].name, 6)])

	def test_u2_return_uses_transit_value_and_source_uom_snapshot(self):
		item = make_item(stock_uom="Kg", purchase_uom=make_uom("Bag"), conversion_factor=50)
		source = self.make_challan(item=item)
		transit_rate = get_stock_balance(item, self.transit, with_valuation_rate=True)[1]
		parent = frappe.db.get_value("Item", item, "variant_of")
		frappe.db.set_value("UOM Conversion Detail", {"parent": parent, "uom": "Bag"}, "conversion_factor", 60)
		frappe.clear_document_cache("Item", parent)
		returned = make_return_delivery_challan(source.name)
		returned.items[0].qty, returned.items[0].rate = 4, 999
		returned.insert().submit()
		self.assertEqual((returned.items[0].conversion_factor, returned.items[0].stock_qty), (50, 200))
		entries = get_voucher_sles(returned.doctype, returned.name)
		self.assertEqual({(row.warehouse, row.qty) for row in entries}, {(self.transit, -200), (self.main, 200)})
		incoming = next(row for row in entries if row.qty > 0)
		self.assertAlmostEqual(incoming.rate, transit_rate, places=5)
		for row in entries:
			self.assertAlmostEqual(row.stock_value_difference, row.qty * transit_rate, places=5)
		assert_transfer_pairs(returned.doctype, returned.name, expected_entries=returned.get_stock_entries())
		self.assertEqual(make_return_delivery_challan(source.name).items[0].qty, 6)
		self.complete(source, 6)
		self.assert_status(source, "Transferred", 6)
		self.assertEqual(source.items[0].returned_qty, 200)

	def test_u3_return_rechecks_completions_and_aggregates_duplicates(self):
		source = self.make_challan()
		returned = make_return(source, {source.items[0].name: 4}, submit=False)
		duplicate = returned.items[0].as_dict()
		duplicate.pop("name")
		returned.append("items", duplicate)
		returned.save()
		self.complete(source, 6)
		with self.assertRaisesRegex(frappe.ValidationError, "Return exceeds"):
			returned.submit()
		# Failed submit advances the in-memory modified timestamp.
		returned.reload()
		returned.remove(returned.items[-1])
		returned.submit()
		self.assert_status(source, "Transferred", 6)

	def test_u3_completion_rechecks_returns_and_ignores_cached_counters(self):
		source = self.make_challan()
		draft = self.draft_completion(source, 7).insert()
		make_return(source, {source.items[0].name: 4})
		frappe.db.set_value("MGK Delivery Challan Item", source.items[0].name, "returned_qty", 0)
		with self.assertRaisesRegex(frappe.ValidationError, "exceeds the pending"):
			draft.submit()
		with self.assertRaisesRegex(frappe.ValidationError, "exceeds the pending"):
			self.complete(source, 7)
		self.complete(source, 6)
		self.assert_status(source, "Transferred", 6)

	def test_u4_u5_full_return_cancel_restores_pending_and_settings_stay_guarded(self):
		source = self.make_challan()
		returned = make_return(source, {source.items[0].name: 10})
		self.assert_status(source, "Returned", 0)
		with self.assertRaisesRegex(frappe.ValidationError, "no remaining quantity"):
			make_return_delivery_challan(source.name)
		with self.assertRaisesRegex(frappe.ValidationError, "cancel it first"):
			self.save_transit_setting(self.second)
		with self.assertRaisesRegex(frappe.ValidationError, "return Delivery Challans"):
			source.cancel()
		returned.cancel()
		self.assert_status(source, "In Transit", 0)
		self.assertEqual(make_return_delivery_challan(source.name).items[0].qty, 10)
		self.assertEqual((self.balance(self.transit), self.balance(self.main)), (10, 0))
		self.complete(source, 6)
		source.reload().cancel()
		self.assertEqual((self.balance(self.transit), self.balance(self.receiving), self.balance(self.main)), (0, 0, 10))

	def test_u5_return_and_completion_cancels_recompute_mixed_status(self):
		source = self.make_challan()
		returned = make_return(source, {source.items[0].name: 4})
		completion = self.complete(source, 6)
		completion.cancel()
		self.assert_status(source, "Partly Transferred", 0)
		returned.cancel()
		self.assert_status(source, "In Transit", 0)

	def test_u2_return_header_and_transit_exception_are_exact(self):
		source = self.make_challan()
		returned = make_return_delivery_challan(source.name)
		returned.from_warehouse = self.receiving
		with self.assertRaisesRegex(frappe.ValidationError, "Return from_warehouse must mirror"):
			returned.insert()
		external = self.make_challan(internal=False)
		returned = make_return_delivery_challan(external.name)
		returned.from_warehouse = self.transit
		with self.assertRaisesRegex(frappe.ValidationError, "Transit Warehouse"):
			returned.insert()

	def test_t14_noninternal_posting_and_close_status_unchanged(self):
		challan = self.make_challan(internal=False)
		receipt = self.make_receipt(internal=False)
		self.assertEqual(challan.close_status, "Open")
		self.assertEqual({row.warehouse for row in get_voucher_sles(challan.doctype, challan.name)},
			{self.main, challan.to_warehouse})
		self.assertEqual(get_voucher_sles(receipt.doctype, receipt.name)[0].warehouse, self.receiving)
		self.assertFalse(challan.transfer_status or receipt.transfer_status)

	def test_r1_uom_snapshot_survives_master_conversion_change(self):
		item = make_item(stock_uom="Kg", purchase_uom=make_uom("Bag"), conversion_factor=50)
		source = self.make_challan(item=item)
		parent = frappe.db.get_value("Item", item, "variant_of")
		frappe.db.set_value("UOM Conversion Detail", {"parent": parent, "uom": "Bag"}, "conversion_factor", 60)
		frappe.clear_document_cache("Item", parent)
		self.assertEqual(resolve_item_uom(item).conversion_factor, 60)
		entry = self.complete(source, 2)
		row = entry.items[0]
		self.assertEqual((row.uom, row.stock_uom, row.conversion_factor, row.stock_qty), ("Bag", "Kg", 50, 100))
		self.assertEqual(self.balance(self.receiving, item), 100)

	def test_r2_current_time_only_and_cannot_precede_source(self):
		source = self.make_receipt()
		for field in ("set_posting_time", "edit_posting_date_and_time"):
			entry = self.draft_completion(source)
			entry.set(field, 1)
			with self.assertRaisesRegex(frappe.ValidationError, "current date and time"):
				entry.insert()
		entry = self.draft_completion(source)
		entry.insert()
		entry.posting_date = add_days(nowdate(), -1)
		with self.assertRaisesRegex(frappe.ValidationError, "cannot be edited"):
			transit.validate_completion(entry, "before_submit")
		frappe.db.set_value(source.doctype, source.name, "posting_date", add_days(nowdate(), 1))
		with self.assertRaisesRegex(frappe.ValidationError, "before the source"):
			self.complete(source)

	def test_r2_completion_posts_inline_at_now(self):
		source = self.make_receipt()
		with patch("yrp.stock.stock_ledger._enqueue_backdated_repost") as queued:
			entry = self.complete(source)
		queued.assert_not_called()
		assert_transfer_pairs(entry.doctype, entry.name, expected_entries=entry.get_sl_entries())

	def test_r2_future_bucket_entries_cannot_force_queued_completion(self):
		source = self.make_receipt()
		future = self.make_receipt(submit=False)
		future.edit_posting_date_and_time = 1
		future.posting_date = add_days(nowdate(), 1)
		future.save().submit()
		with self.assertRaisesRegex(frappe.ValidationError, "Resolve future stock entry"):
			self.complete(source)
		self.assert_status(source, "In Transit", 0)

	def test_r3_cancel_restores_persisted_completion_rows_and_warehouses(self):
		source = self.make_receipt()
		entry = self.complete(source)
		entry.items[0].qty = 1
		entry.to_warehouse = self.second
		entry.cancel()
		self.assertEqual((self.balance(self.receiving), self.balance(self.second)), (0, 0))
		self.assert_status(source, "In Transit", 0)

	def test_r3_completion_cancel_checks_later_linked_movements(self):
		source = self.make_receipt()
		completion = self.complete(source)
		later = make_delivery_challan(from_warehouse=self.receiving, to_supplier=self.vendor,
			to_warehouse=make_warehouse(supplier=self.vendor), items=[{"item": self.item, "qty": 1}])
		with self.assertRaisesRegex(frappe.ValidationError, later.name):
			completion.cancel()

	def test_r4_source_lock_precedes_stock_entry_creation(self):
		source = self.make_receipt()
		events = []
		original_lock, original_new = transit.lock_documents, frappe.new_doc
		original_settings = transit.get_transit_warehouse

		def lock(documents):
			events.append("source")
			return original_lock(documents)

		def create(doctype, *args, **kwargs):
			if doctype == "YRP Stock Entry":
				events.append("entry")
			return original_new(doctype, *args, **kwargs)

		def settings(**kwargs):
			events.append("settings")
			return original_settings(**kwargs)

		with (patch.object(transit, "lock_documents", lock), patch("frappe.new_doc", create),
			patch.object(transit, "get_transit_warehouse", settings)):
			self.complete(source)
		self.assertLess(events.index("source"), events.index("settings"))
		self.assertLess(events.index("settings"), events.index("entry"))

	def test_r6_setting_change_blocked_until_all_submitted_transfers_cancelled(self):
		sources = [self.make_challan(), self.make_receipt(item=make_item(stock_uom="Kg"))]
		other = make_warehouse()
		with self.assertRaisesRegex(frappe.ValidationError, f"{sources[0].name}.*cancel it first"):
			self.save_transit_setting(other)
		completions = [self.complete(source) for source in sources]
		for source in sources:
			self.assert_status(source, "Transferred", 10)
		with self.assertRaisesRegex(frappe.ValidationError, "cancel it first"):
			self.save_transit_setting(other)
		completions[0].cancel()
		sources[0].reload().cancel()
		with self.assertRaisesRegex(frappe.ValidationError, f"{sources[1].name}.*cancel it first"):
			self.save_transit_setting(other)
		sources[1].reload().cancel()
		self.save_transit_setting(other)
		self.assertEqual(frappe.db.get_single_value("YRP Stock Settings", "transit_warehouse", cache=False), other)
		self.assertEqual(completions[1].reload().docstatus, 2)

	def test_r6_partial_dc_blocks_setting_change_and_source_cancel_uses_snapshot(self):
		source = self.make_challan()
		entry = self.complete(source, 6)
		warehouse = make_warehouse()
		with self.assertRaisesRegex(frappe.ValidationError, "cancel it first"):
			self.save_transit_setting(warehouse)
		entry.cancel()
		self.set_transit(warehouse)
		source.reload().cancel()
		self.assertEqual((self.balance(self.transit), self.balance(self.main)), (0, 10))

	def test_f4_update_after_submit_cannot_change_transit_fields(self):
		for factory in (self.make_challan, self.make_receipt):
			source = factory()
			for field, value in (("transfer_status", "Transferred"), ("transferred_qty", 10),
				("is_internal_transfer", 0), ("transit_warehouse", self.second)):
				attempt = frappe.get_doc(source.doctype, source.name)
				target = attempt.items[0] if field == "transferred_qty" else attempt
				target.set(field, value)
				with self.subTest(doctype=source.doctype, field=field), self.assertRaises(frappe.UpdateAfterSubmitError):
					attempt.save()
			self.assert_status(source, "In Transit", 0)
			self.complete(source)
			self.assert_status(source, "Transferred", 10)

	def test_r8_internal_grn_cannot_link_even_noninternal_dc(self):
		challan = self.make_challan(internal=False)
		receipt = make_job_work_grn(supplier=self.origin, warehouse=self.receiving,
			items=[{"item": self.item, "qty": 1}], submit=False)
		receipt.delivery_location = self.destination
		receipt.append("delivery_challans", {"delivery_challan": challan.name})
		with self.assertRaisesRegex(frappe.ValidationError, "internal transfer; cannot link"):
			receipt.save()

	def test_r10_internal_receipt_cannot_feed_receipt_linked_dc(self):
		receipt = self.make_receipt()
		with self.assertRaisesRegex(frappe.ValidationError, "internal transfer; cannot create"):
			make_delivery_challan(from_warehouse=self.receiving, to_supplier=self.vendor,
				to_warehouse=make_warehouse(supplier=self.vendor), purchase_order=receipt.purchase_order,
				goods_received_note=receipt.name, items=[{"item": self.item, "qty": 10}])

	def test_r11_rejects_transit_in_every_source_destination_position(self):
		for factory, field in ((self.make_challan, "from_warehouse"), (self.make_challan, "to_warehouse"),
			(self.make_receipt, "warehouse")):
			source = factory(submit=False)
			source.set(field, self.transit)
			with self.subTest(field=field), self.assertRaisesRegex(frappe.ValidationError, "Transit Warehouse"):
				source.save()
		with self.assertRaisesRegex(frappe.ValidationError, "Transit Warehouse"):
			self.complete(self.make_receipt(), warehouse=self.transit)

	def test_r12_pi_after_partial_completion_revalues_both_legs_and_reverses(self):
		adjustment = "yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment"
		self.enterContext(patch(f"{adjustment}.enqueue_adjustment"))
		for module in (adjustment, "mgk_yrp.purchase.revaluation"):
			self.enterContext(patch(f"{module}.is_stock_adjustment_enabled", return_value=True))
		source = self.make_receipt()
		completion = self.complete(source, 6)
		invoice = make_purchase_invoice(against="Purchase Order", supplier=self.origin, grns=[source],
			rates={source.items[0].name: 110})
		run_adjustments(invoice.doctype, invoice.name)
		incoming = next(row for row in get_voucher_sles(completion.doctype, completion.name) if row.qty > 0)
		self.assertAlmostEqual(incoming.valuation_adjustment_value, 60, places=5)
		self.assertAlmostEqual(get_stock_balance(self.item, self.transit, with_valuation_rate=True)[1], 110, places=5)
		invoice.cancel()
		run_adjustments(invoice.doctype, invoice.name)
		incoming = next(row for row in get_voucher_sles(completion.doctype, completion.name) if row.qty > 0)
		self.assertAlmostEqual(incoming.valuation_adjustment_value, 0, places=5)
		self.assertAlmostEqual(get_stock_balance(self.item, self.transit, with_valuation_rate=True)[1], 100, places=5)
