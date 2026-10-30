from unittest import TestCase
from unittest.mock import Mock, call, patch

import frappe
from yrp.stock import dimensions

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import MGKDeliveryChallan
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.stock import dimension_fields, transit
from mgk_yrp.tests import test_mark_as_received, test_transit
from mgk_yrp.tests.test_item_editor import EditorDocument, validation_error

TRANSIT = "mgk_yrp.stock.transit"


class TestTransitUnit(TestCase):
	"""Transit guards without a site, database, or Redis connection."""

	def setUp(self):
		self.database = Mock()
		self.database.sql.return_value = [("Transit",)]
		self.database.is_deadlocked.return_value = False
		self.database.is_timedout.return_value = False
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", side_effect=validation_error))
		self.enterContext(patch("frappe.generate_hash", return_value="checkpoint"))
		self.enterContext(patch(f"{TRANSIT}._", side_effect=lambda message: message))
		self.source = EditorDocument(
			doctype="MGK Delivery Challan", name="DC-1", docstatus=1,
			is_internal_transfer=1, transit_warehouse="Transit", items=[],
			check_permission=Mock(),
		)

	def test_f8_settings_save_patches_schema_sync(self):
		settings = Mock()
		original_sync = dimension_fields.sync_dimension_fields
		original_create = dimensions.create_dimension_fields

		def save():
			self.assertIsNot(dimensions.create_dimension_fields, original_create)
			dimensions.create_dimension_fields()
			dimensions.create_dimension_fields.assert_called_once_with()
			self.assertIsNot(dimension_fields.sync_dimension_fields, original_sync)
			dimension_fields.sync_dimension_fields(settings, "on_update")
			dimension_fields.sync_dimension_fields.assert_called_once_with(settings, "on_update")

		settings.save.side_effect = save
		with patch("frappe.get_single", return_value=settings):
			test_transit.TestTransit().save_transit_setting("Other")
		settings.save.assert_called_once_with()
		self.assertEqual(settings.transit_warehouse, "Other")
		self.assertIs(dimension_fields.sync_dimension_fields, original_sync)
		self.assertIs(dimensions.create_dimension_fields, original_create)
		self.database.commit.assert_not_called()

	def test_f8_cleanup_rolls_back_before_restoring_transit_even_if_setup_fails(self):
		for module, case_class in (
			(test_transit, test_transit.TestTransit),
			(test_mark_as_received, test_mark_as_received.TestMarkAsReceived),
		):
			for previous in (None, "Original Transit"):
				self.database.get_single_value.return_value = previous
				sequence = Mock()
				sequence.attach_mock(self.database.rollback, "rollback")
				sequence.attach_mock(self.database.set_single_value, "restore")
				case = case_class()
				with (
					self.subTest(case=case_class.__name__, previous=previous),
					patch.object(module.IntegrationTestCase, "setUp"),
					patch(f"{module.__name__}.make_supplier", side_effect=RuntimeError("fixture failed")),
					patch("frappe.clear_document_cache", sequence.clear_cache),
				):
					with self.assertRaisesRegex(RuntimeError, "fixture failed"):
						case.setUp()
					self.assertTrue(case.doCleanups())
					self.assertEqual(sequence.mock_calls, [
						call.rollback(),
						call.restore("YRP Stock Settings", "transit_warehouse", previous),
						call.clear_cache("YRP Stock Settings", "YRP Stock Settings"),
					])

	def test_f2_optional_internal_flag_on_document_like_sources(self):
		for field in ("to_warehouse", "warehouse"):
			source = EditorDocument(**{field: "Receiving"})
			self.assertEqual(transit.get_receiving_warehouse(source), "Receiving")
			transit.reject_internal_action(source, "close")
		self.assertEqual(transit.get_receiving_warehouse(self.source), "Transit")
		with self.assertRaisesRegex(frappe.ValidationError, "is an internal transfer"):
			transit.reject_internal_action(self.source, "close")

	def test_f5_setting_change_blocks_submitted_sources_using_current_warehouse(self):
		self.database.get_single_value.return_value = "Transit"
		for doctype, results in (
			("MGK Delivery Challan", [[("DC-1",)]]),
			("MGK Goods Received Note", [[], [("GRN-1",)]]),
		):
			self.database.sql.reset_mock()
			self.database.sql.side_effect = results
			with self.subTest(doctype=doctype), self.assertRaisesRegex(frappe.ValidationError, "cancel it first"):
				transit.validate_settings(EditorDocument(transit_warehouse="Other"))
			query, values = self.database.sql.call_args.args
			self.assertIn(f"`tab{doctype}`", query)
			self.assertIn("source.docstatus = 1 AND source.is_internal_transfer = 1", query)
			self.assertIn("source.transit_warehouse = %s", query)
			self.assertNotIn("transferred_qty", query)
			self.assertEqual(values, ("Transit",))

	def test_f5_f7_settings_validation_exclusively_locks_current_value(self):
		self.database.get_single_value.return_value = "Transit"
		self.database.sql.return_value = []
		transit.validate_settings(EditorDocument(transit_warehouse="Other"))
		self.database.get_single_value.assert_called_once_with(
			"YRP Stock Settings", "transit_warehouse", cache=False, for_update=True
		)
		self.assertEqual(self.database.sql.call_count, 2)
		self.database.sql.reset_mock()
		transit.validate_settings(EditorDocument(transit_warehouse="Transit"))
		self.database.sql.assert_not_called()

	def test_f6_aborted_transaction_preserves_original_error_without_savepoint_rollback(self):
		for error, detector in (
			(RuntimeError(1213, "Deadlock"), "is_deadlocked"),
			(RuntimeError(1205, "Lock wait timeout"), "is_timedout"),
			(frappe.QueryDeadlockError("Deadlock"), None),
			(frappe.QueryTimeoutError("Lock wait timeout"), None),
		):
			self.database.is_deadlocked.return_value = detector == "is_deadlocked"
			self.database.is_timedout.return_value = detector == "is_timedout"
			with patch(f"{TRANSIT}.cancel_submitted_completions", side_effect=error):
				with self.subTest(error=error), self.assertRaises(type(error)) as raised:
					transit.cancel_completions(self.source)
			self.assertIs(raised.exception, error)
		self.database.rollback.assert_not_called()
		self.database.release_savepoint.assert_not_called()

	def test_f6_ordinary_cancel_failure_rolls_back_savepoint(self):
		error = frappe.ValidationError("Insufficient stock")
		with patch(f"{TRANSIT}.cancel_submitted_completions", side_effect=error):
			with self.assertRaises(frappe.ValidationError) as raised:
				transit.cancel_completions(self.source)
		self.assertIs(raised.exception, error)
		self.database.rollback.assert_called_once_with(save_point="transit_cancel_checkpoint")
		self.database.release_savepoint.assert_not_called()

	def test_f6_f7_successful_cancel_holds_shared_settings_lock_and_releases_savepoint(self):
		with (patch(f"{TRANSIT}.cancel_submitted_completions"),
			patch(f"{TRANSIT}.validate_backdated_cancel")):
			transit.cancel_completions(self.source)
		self.assertTrue(self.database.sql.call_args.args[0].strip().endswith("LOCK IN SHARE MODE"))
		self.database.release_savepoint.assert_called_once_with("transit_cancel_checkpoint")
		self.database.rollback.assert_not_called()
		self.assertEqual(self.source.transfer_status, "")

	def test_f7_transfer_settings_read_is_shared_and_uncached(self):
		self.assertEqual(transit.get_transit_warehouse(shared_lock=True), "Transit")
		query, values = self.database.sql.call_args.args
		self.assertIn("`tabSingles`", query)
		self.assertTrue(query.strip().endswith("LOCK IN SHARE MODE"))
		self.assertEqual(values, ("YRP Stock Settings", "transit_warehouse"))
		self.database.get_single_value.assert_not_called()
		self.database.sql.return_value = []
		with self.assertRaisesRegex(frappe.ValidationError, "Set Transit Warehouse"):
			transit.get_transit_warehouse(shared_lock=True)

	def test_f7_submit_locks_source_before_shared_settings_read(self):
		for controller, doctype in (
			(MGKDeliveryChallan, "MGK Delivery Challan"),
			(MGKGoodsReceivedNote, "MGK Goods Received Note"),
		):
			sequence = Mock()
			source = EditorDocument(
				doctype=doctype,
				items=[], is_internal_transfer=1, against_purchase_order=0,
				lock_sources=sequence.source, set_job_work_rows=Mock(),
			)
			with (
				patch(f"{controller.__module__}.validate_stock_dimensions"),
				patch(f"{TRANSIT}.set_internal_transfer"),
				patch(f"{TRANSIT}.get_transit_warehouse", sequence.settings),
			):
				sequence.settings.side_effect = RuntimeError("stop at settings read")
				with self.subTest(controller=controller.__name__), self.assertRaisesRegex(RuntimeError, "stop"):
					controller.before_submit(source)
			self.assertEqual(sequence.mock_calls, [call.source(), call.settings(shared_lock=True)])

	def test_f7_completion_locks_source_before_shared_settings_read(self):
		sequence = Mock()
		sequence.settings.return_value = [("Transit",)]
		self.database.sql = sequence.settings
		with (
			patch("frappe.has_permission"), patch("frappe.get_doc", return_value=self.source),
			patch(f"{TRANSIT}.lock_documents", sequence.source),
			patch(f"{TRANSIT}.validate_stock_dimensions"), patch(f"{TRANSIT}.validate_destination"),
			patch("frappe.new_doc", side_effect=RuntimeError("stop at entry creation")),
		):
			with self.assertRaisesRegex(RuntimeError, "stop"):
				transit.complete_transfer(self.source.doctype, self.source.name, "Receiving", [])
		self.assertEqual([event[0] for event in sequence.mock_calls], ["source", "settings"])

	def test_f7_standalone_cancel_locks_source_before_shared_settings_read(self):
		sequence = Mock()
		sequence.settings.return_value = [("Transit",)]
		self.database.sql = sequence.settings
		entry = EditorDocument(
			against=self.source.doctype, against_id=self.source.name, from_warehouse="Transit",
			to_warehouse="Receiving", items=[], flags=frappe._dict(),
			get_doc_before_save=Mock(return_value=None), reload=Mock(),
		)
		with (
			patch("frappe.get_doc", return_value=self.source),
			patch(f"{TRANSIT}.lock_documents", sequence.source),
			patch(f"{TRANSIT}.validate_stock_dimensions"), patch(f"{TRANSIT}.validate_backdated_cancel"),
		):
			transit.before_completion_cancel(entry)
		self.assertEqual([event[0] for event in sequence.mock_calls], ["source", "settings"])
		self.assertEqual(entry.docstatus, 2)
