from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call, patch

import frappe

from mgk_yrp import hooks
from mgk_yrp.stock.dimension_fields import (
	CHILD_DOCTYPES,
	MANAGED_MARKER,
	dimension_field,
	sync_dimension_fields,
)
from mgk_yrp.tests.test_received_type import RECEIVED_TYPE

FIELDS = "mgk_yrp.stock.dimension_fields"


class TestDimensionFields(TestCase):
	def test_plan_received_type_uses_the_receipt_dimension_contract(self):
		self.assertIn("MGK Process Planning Item", CHILD_DOCTYPES)
		self.assertEqual(
			dimension_field(RECEIVED_TYPE, "MGK Process Planning Item"),
			dimension_field(RECEIVED_TYPE, "MGK Goods Received Note Item"),
		)

	def test_sync_creates_updates_removes_idempotently_outside_fixtures(self):
		stored = {}
		dimensions = [RECEIVED_TYPE]
		cache = []

		def create(fields, update):
			self.assertTrue(update)
			for doctype, definitions in fields.items():
				for definition in definitions:
					stored[f"{doctype}-{definition['fieldname']}"] = {"dt": doctype, **definition}

		def managed_fields(*args, **kwargs):
			self.assertEqual(kwargs["filters"]["description"], MANAGED_MARKER)
			return [frappe._dict(name=name, fieldname=field["fieldname"]) for name, field in stored.items()]

		with (
			patch(f"{FIELDS}.clear_dimension_cache", side_effect=lambda: cache.append("clear")),
			patch(
				f"{FIELDS}.get_stock_dimensions",
				side_effect=lambda: dimensions if cache else self.fail("stale cache"),
			),
			patch(f"{FIELDS}.create_custom_fields", side_effect=create),
			patch("frappe.get_all", side_effect=managed_fields),
			patch("frappe.clear_cache"),
			patch("frappe.db", Mock(), create=True),
			patch("frappe.delete_doc", side_effect=AssertionError("Use scoped cleanup")),
			patch(
				"frappe.db.delete", side_effect=lambda doctype, filters: stored.pop(filters["name"])
			) as delete,
		):
			sync_dimension_fields()
			sync_dimension_fields()
			self.assertEqual(len(stored), len(CHILD_DOCTYPES))
			for field in stored.values():
				self.assertEqual(field["fieldtype"], "Link")
				self.assertEqual(field["options"], "YRP Received Type")
				self.assertEqual(field["reqd"], int(field["dt"] != "MGK Purchase Order Item"))
				self.assertNotEqual(field["module"], hooks.fixtures[0]["filters"][0][2])
			dimensions[0] = {**RECEIVED_TYPE, "mandatory": 0}
			sync_dimension_fields()
			self.assertTrue(all(not field["reqd"] for field in stored.values()))
			dimensions.clear()
			sync_dimension_fields()
			sync_dimension_fields()
			self.assertEqual(stored, {})
			self.assertEqual(delete.call_count, len(CHILD_DOCTYPES))

	def test_system_manager_removes_only_owned_orphans_and_clears_meta(self):
		fields = [
			frappe._dict(name=f"{doctype}-obsolete", fieldname="obsolete") for doctype in CHILD_DOCTYPES
		]
		fields.append(frappe._dict(name="active", fieldname="received_type"))
		operations = Mock()
		with (
			patch("frappe.session", SimpleNamespace(user="manager@example.com")),
			patch("frappe.db", Mock(delete=operations.delete), create=True),
			patch(
				"frappe.delete_doc", side_effect=frappe.ValidationError("Administrator-owned field")
			) as trash,
			patch(f"{FIELDS}.clear_dimension_cache"),
			patch(f"{FIELDS}.get_stock_dimensions", return_value=[RECEIVED_TYPE]),
			patch(f"{FIELDS}.create_custom_fields"),
			patch("frappe.get_all", return_value=fields) as get_fields,
			patch("frappe.clear_cache", operations.clear_cache),
		):
			sync_dimension_fields()
		trash.assert_not_called()
		get_fields.assert_called_once_with(
			"Custom Field",
			filters={"dt": ["in", CHILD_DOCTYPES], "description": MANAGED_MARKER},
			fields=["name", "fieldname"],
		)
		self.assertEqual(
			operations.mock_calls,
			[
				*(
					call.delete(
						"Custom Field",
						{"name": field.name, "dt": ["in", CHILD_DOCTYPES], "description": MANAGED_MARKER},
					)
					for field in fields[:-1]
				),
				*(call.clear_cache(doctype=doctype) for doctype in CHILD_DOCTYPES),
			],
		)

	def test_hooks_sync_after_migration_and_settings_save(self):
		path = f"{FIELDS}.sync_dimension_fields"
		self.assertIn(path, hooks.after_migrate)
		self.assertEqual(hooks.doc_events["YRP Stock Settings"]["on_update"], path)
