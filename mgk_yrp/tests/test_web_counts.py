import json
from unittest.mock import call, patch

import frappe
from frappe.tests import IntegrationTestCase
from yrp.yrp.doctype.yrp_item.yrp_item import create_variant

from mgk_yrp.tests.fixtures import make_item, make_supplier, make_template_item
from mgk_yrp.web.list_counts import MAX_FILTER_SETS, get_counts

COUNTS = "mgk_yrp.web.list_counts"


class TestWebCounts(IntegrationTestCase):
	def test_batches_counts_in_input_order_using_permission_aware_queries(self):
		sets = [
			{"doctype": "MGK Delivery Challan", "filters": []},
			{"doctype": "MGK Goods Received Note", "filters": [["against_purchase_order", "=", 1]]},
		]
		with (
			patch(f"{COUNTS}.frappe.has_permission", return_value=True),
			patch(f"{COUNTS}.frappe.get_list", side_effect=[[{"count": 7}], [{"count": 2}]]) as query,
		):
			self.assertEqual(get_counts(json.dumps(sets)), [7, 2])
		self.assertEqual(query.call_args_list, [
			call(entry["doctype"], filters=entry["filters"], fields=[{"COUNT": "*", "as": "count"}], limit=1, order_by="")
			for entry in sets
		])

	def test_rejects_more_than_twenty_sets_before_querying(self):
		sets = [{"doctype": "Supplier", "filters": []}] * (MAX_FILTER_SETS + 1)
		with patch(f"{COUNTS}.frappe.get_list") as query, self.assertRaises(frappe.ValidationError):
			get_counts(sets)
		query.assert_not_called()

	def test_checks_all_doctypes_before_counting_anything(self):
		sets = [{"doctype": "Supplier", "filters": []}, {"doctype": "MGK Purchase Invoice", "filters": []}]
		with (
			patch(f"{COUNTS}.frappe.has_permission", side_effect=lambda dt, permission: dt == "Supplier"),
			patch(f"{COUNTS}.frappe.get_list") as query,
			self.assertRaises(frappe.PermissionError),
		):
			get_counts(sets)
		counted = [call for call in query.call_args_list if call.args and call.args[0] != "Translation"]
		self.assertEqual(counted, [])

	def test_rejects_malformed_payloads(self):
		for payload in ("not JSON", "{}", None, [None], [{"doctype": "", "filters": []}], [{"doctype": "Supplier", "filters": {}}], [{"doctype": "Item", "filters": [], "or_filters": {}}]):
			with self.subTest(payload=payload), self.assertRaises(frappe.ValidationError):
				get_counts(payload)

	def test_forwards_each_or_filter_set_to_permission_aware_query(self):
		entry = {
			"doctype": "Item", "filters": [["variant_of", "is", "not set"]],
			"or_filters": [["has_variants", "=", 1], ["disabled", "=", 0]],
		}
		with (
			patch(f"{COUNTS}.frappe.has_permission", return_value=True),
			patch(f"{COUNTS}.frappe.get_list", return_value=[{"count": 3}]) as query,
		):
			self.assertEqual(get_counts(json.dumps([entry])), [3])
		query.assert_called_once_with(
			"Item", filters=entry["filters"], or_filters=entry["or_filters"],
			fields=[{"COUNT": "*", "as": "count"}], limit=1, order_by="",
		)

	def test_item_or_filters_count_disabled_templates_and_enabled_plain_items_only(self):
		original_user = frappe.session.user
		self.addCleanup(frappe.set_user, original_user)
		frappe.set_user("Administrator")
		names = []
		for disabled in (0, 1):
			template, attributes = make_template_item()
			variant = create_variant(template.name, attributes).insert(ignore_permissions=True)
			plain = make_item(stock_uom="Kg")
			for name in (template.name, variant.name, plain):
				frappe.db.set_value("Item", name, "disabled", disabled)
				names.append(name)
		filters = [["name", "in", names], ["variant_of", "is", "not set"]]
		self.assertEqual(get_counts([{
			"doctype": "Item", "filters": filters,
			"or_filters": [["has_variants", "=", 1], ["disabled", "=", 0]],
		}]), [3])

	def test_empty_batch_and_twenty_sets_are_accepted(self):
		self.assertEqual(get_counts([]), [])
		with (
			patch(f"{COUNTS}.frappe.has_permission", return_value=True),
			patch(f"{COUNTS}.frappe.get_list", return_value=[{"count": 0}]),
		):
			self.assertEqual(get_counts([{"doctype": "Supplier", "filters": []}] * MAX_FILTER_SETS), [0] * MAX_FILTER_SETS)

	def test_real_counts_respect_supplier_user_permissions(self):
		original_user = frappe.session.user
		self.addCleanup(frappe.set_user, original_user)
		frappe.set_user("Administrator")
		allowed, hidden = make_supplier(), make_supplier()
		user = frappe.get_doc({
			"doctype": "User",
			"email": f"mgk-counts-{frappe.generate_hash(length=10)}@example.test",
			"first_name": "MGK Counts",
			"send_welcome_email": 0,
			"roles": [{"role": "Stock User"}],
		}).insert(ignore_permissions=True)
		frappe.get_doc({
			"doctype": "User Permission", "user": user.name, "allow": "Supplier",
			"for_value": allowed, "apply_to_all_doctypes": 1,
		}).insert(ignore_permissions=True)
		frappe.clear_cache(user=user.name)
		frappe.set_user(user.name)
		sets = [
			{"doctype": "Supplier", "filters": [["name", "in", [allowed, hidden]]]},
			{"doctype": "Supplier", "filters": [["name", "=", hidden]]},
		]
		self.assertTrue(frappe.has_permission("Supplier", "read"))
		self.assertEqual(get_counts(sets), [1, 0])
		with self.assertRaises(frappe.PermissionError):
			get_counts([{"doctype": "MGK Purchase Invoice", "filters": []}])
