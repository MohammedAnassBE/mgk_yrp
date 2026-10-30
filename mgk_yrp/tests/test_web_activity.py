import json
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from mgk_yrp.web.activity import VersionParser, get_document_activity

MODULE = "mgk_yrp.web.activity"


class TestWebActivity(IntegrationTestCase):
	def test_read_permission_is_checked_before_history_or_stamps(self):
		with (
			patch(f"{MODULE}.frappe.has_permission", return_value=False),
			patch(f"{MODULE}.frappe.get_all") as query,
			self.assertRaises(frappe.PermissionError),
		):
			get_document_activity("MGK Purchase Order", "hidden")
		query.assert_not_called()

	def test_pagination_is_bounded_and_full_names_are_returned(self):
		stamps = frappe._dict(
			owner="user@example.test",
			modified_by="user@example.test",
			creation="2026-10-29",
			modified="2026-10-29",
		)
		with (
			patch(f"{MODULE}.frappe.has_permission", return_value=True),
			patch(f"{MODULE}.frappe.db.get_value", return_value=stamps),
			patch(f"{MODULE}.get_version_page", return_value=([{"user": stamps.owner}], 51, True)) as page,
			patch(f"{MODULE}.get_full_names", return_value={stamps.owner: "Stock User"}),
		):
			result = get_document_activity("MGK Purchase Order", "PO-1", start=-1, page_length=200)
		self.assertEqual(page.call_args.args[2:], (0, 50))
		self.assertEqual(result["versions"][0]["user_name"], "Stock User")
		self.assertEqual(result["created"]["user_name"], "Stock User")
		self.assertTrue(result["has_more"])
		self.assertEqual(result["next_start"], 51)

	def parser(self):
		meta = frappe.get_meta("MGK Purchase Order")
		with patch.object(meta, "get_permlevel_access", return_value=[0]):
			return VersionParser(meta)

	def version(self, **data):
		return {
			"name": "version-1",
			"owner": "user@example.test",
			"creation": "2026-10-29",
			"data": json.dumps(data),
		}

	def test_field_changes_rows_and_submit_cancel_are_rendered(self):
		parser = self.parser()
		entry = parser.parse(
			self.version(
				changed=[["supplier", "Old", "New"], ["docstatus", 0, 1]],
				added=[["items", {"item": "Yarn"}]],
				removed=[["items", {"item": "Other"}]],
				row_changed=[["items", 0, "row-1", [["qty", 1, 2]]]],
			)
		)
		self.assertEqual(entry["events"], ["submitted"])
		self.assertEqual(entry["changes"][0]["label"], "Supplier")
		self.assertEqual(entry["rows_added"][0]["count"], 1)
		self.assertEqual(entry["rows_removed"][0]["count"], 1)
		self.assertEqual(entry["row_changes"][0]["row"], 1)
		self.assertEqual(parser.parse(self.version(changed=[["docstatus", 1, 2]]))["events"], ["cancelled"])

	def test_hidden_and_unreadable_permlevels_are_filtered(self):
		parser = self.parser()
		field = frappe._dict(fieldname="secret", label="Secret", fieldtype="Data", permlevel=1)
		with patch.object(parser.meta, "get_field", return_value=field):
			self.assertIsNone(parser.parse(self.version(changed=[["secret", "a", "b"]])))
		field.update(permlevel=0, hidden=1)
		with patch.object(parser.meta, "get_field", return_value=field):
			self.assertIsNone(parser.parse(self.version(changed=[["secret", "a", "b"]])))

	def test_empty_versions_are_skipped_without_breaking_pagination(self):
		from mgk_yrp.web.activity import get_version_page

		rows = [self.version(changed=[["unknown_field", 1, 2]]), self.version(changed=[["docstatus", 0, 1]])]
		meta = frappe.get_meta("MGK Purchase Order")
		get_all = frappe.get_all

		def version_query(doctype, *args, **kwargs):
			return rows if doctype == "Version" else get_all(doctype, *args, **kwargs)

		with patch(f"{MODULE}.frappe.get_all", side_effect=version_query):
			entries, next_start, has_more = get_version_page(meta, "PO-1", 0, 1)
		self.assertEqual(len(entries), 1)
		self.assertEqual(next_start, 2)
		self.assertFalse(has_more)
