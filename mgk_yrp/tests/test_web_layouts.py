import json
from pathlib import Path

import frappe
from frappe.tests import IntegrationTestCase
from yrp.yrp.api.ui_config import validate_config

from mgk_yrp import hooks

EXPECTED_BOOKS = {
	"MGK Workspace": ["purchase-order", "billing", "delivery-challan", "delivery-challan-close", "goods-received-note"],
	"Stock Users": ["delivery-challan", "delivery-challan-close", "goods-received-note"],
	"Billing": ["billing"],
	"Purchase": ["purchase-order"],
	"PO and Bills": ["purchase-order", "billing"],
}


class TestWebLayouts(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		fixture = Path(__file__).resolve().parents[1] / "fixtures" / "yrp_ui_layout.json"
		self.layouts = json.loads(fixture.read_text(encoding="utf-8"))

	def test_fixture_contains_exactly_five_enabled_configurable_layouts(self):
		self.assertCountEqual([layout["name"] for layout in self.layouts], EXPECTED_BOOKS)
		for layout in self.layouts:
			with self.subTest(layout=layout["name"]):
				self.assertEqual(layout["doctype"], "YRP UI Layout")
				self.assertEqual(layout["layout_name"], layout["name"])
				self.assertEqual(layout["disabled"], 0)
				self.assertEqual(layout["docstatus"], 0)
				self.assertEqual(layout["render_mode"], "Configurable Layout")
				self.assertIsNone(layout["experience_key"])
				self.assertTrue(layout["description"].strip())

	def test_configs_contain_only_the_requested_books_in_order_with_stable_ids(self):
		for layout in self.layouts:
			with self.subTest(layout=layout["name"]):
				self.assertIsInstance(layout["config"], str)
				blocks = [{"id": book, "type": f"mgk-{book}"} for book in EXPECTED_BOOKS[layout["name"]]]
				self.assertEqual(
					json.loads(layout["config"]),
					{"schema_version": 1, "screens": {"home": {"blocks": blocks}}},
				)

	def test_yrp_validator_accepts_each_config_without_hard_errors(self):
		for layout in self.layouts:
			with self.subTest(layout=layout["name"]):
				warnings = validate_config(layout["config"], layer="layout")
				self.assertIsInstance(warnings, list)

	def test_hooks_export_only_the_five_named_layouts_and_keep_existing_fixtures(self):
		layouts = [fixture for fixture in hooks.fixtures if fixture.get("dt") == "YRP UI Layout"]
		self.assertEqual(layouts, [{"dt": "YRP UI Layout", "filters": [["name", "in", list(EXPECTED_BOOKS)]]}])
		for doctype in ("Custom Field", "Property Setter"):
			self.assertIn({"dt": doctype, "filters": [["module", "=", "MGK YRP"]]}, hooks.fixtures)

	def test_migrate_imported_layouts_match_shipped_records(self):
		for layout in self.layouts:
			with self.subTest(layout=layout["name"]):
				document = frappe.get_doc("YRP UI Layout", layout["name"])
				for field in ("layout_name", "disabled", "docstatus", "render_mode", "experience_key", "description"):
					self.assertEqual(document.get(field), layout[field], field)
				self.assertEqual(json.loads(document.config), json.loads(layout["config"]))
