import json
from pathlib import Path
from unittest import TestCase

import frappe
from frappe.model.sync import get_doc_files
from frappe.tests import IntegrationTestCase

from mgk_yrp import hooks

PACKAGE = Path(__file__).resolve().parents[1]
TRANSACTIONS = {
	"MGK Purchase Order",
	"MGK Goods Received Note",
	"MGK Delivery Challan",
	"MGK Delivery Challan Close",
	"MGK Purchase Invoice",
}
LINKS = {
	*(("DocType", name) for name in TRANSACTIONS | {"MGK Agent", "MGK Settings"}),
	("DocType", "YRP Stock Valuation Adjustment"),
	("Report", "YRP Stock Balance"),
	("Report", "YRP Stock Valuation"),
}


class TestWorkspaceFiles(TestCase):
	def test_sidebar_is_discovered_by_migrate(self):
		files = get_doc_files([], str(PACKAGE / "mgk_yrp"), doctypes=[("desk", "sidebar")])
		self.assertIn(str(PACKAGE / "mgk_yrp/sidebar/mgk/mgk.json"), files)

	def test_sidebar_has_only_mgk_documents_and_stock_reports(self):
		sidebar = json.loads((PACKAGE / "mgk_yrp/sidebar/mgk/mgk.json").read_text())
		legacy = json.loads((PACKAGE / "workspace_sidebar/mgk.json").read_text())
		self.assertEqual(sidebar["module"], "MGK YRP")
		self.assertEqual(sidebar["title"], "MGK")
		self.assertEqual(sidebar["standard"], 1)
		self.assertEqual(sidebar["items"], legacy["items"])
		self.assertEqual({(row["link_type"], row["link_to"]) for row in sidebar["items"]}, LINKS)
		self.assertEqual(len(sidebar["items"]), len(LINKS))

	def test_desktop_icon_opens_mgk_sidebar(self):
		icon = json.loads((PACKAGE / "desktop_icon/mgk.json").read_text())
		self.assertEqual(icon["label"], "MGK")
		self.assertEqual(icon["link_to"], "MGK")
		self.assertEqual(icon["link_type"], "Workspace Sidebar")
		self.assertEqual(icon["app"], "mgk_yrp")
		self.assertEqual(icon["hidden"], 0)
		self.assertFalse(icon.get("parent_icon"))

	def test_apps_screen_opens_mgk_sidebar(self):
		entry = hooks.add_to_apps_screen[0]
		self.assertEqual(entry["name"], "mgk_yrp")
		self.assertEqual(entry["title"], "MGK")
		self.assertEqual(entry["title"], hooks.app_title)
		self.assertEqual(entry["route"], "/desk/mgk")
		logo = entry["logo"].removeprefix("/assets/mgk_yrp/")
		self.assertTrue((PACKAGE / "public" / logo).is_file())


class TestWorkspace(IntegrationTestCase):
	def test_workspace_sidebar_lists_mgk_doctypes(self):
		sidebar = frappe.get_doc("Sidebar", "MGK")
		self.assertEqual(sidebar.module, "MGK YRP")
		self.assertEqual({(row.link_type, row.link_to) for row in sidebar.items}, LINKS)
		self.assertEqual(len(sidebar.items), len(LINKS))
