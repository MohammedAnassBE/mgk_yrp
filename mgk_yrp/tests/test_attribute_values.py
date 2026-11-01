from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from yrp.attribute_values import get_mapping_values
from yrp.yrp.doctype.yrp_item.yrp_item import (
	ensure_global_attribute_values,
	search_item_attribute_values,
)

from mgk_yrp.stock.attribute_values import create_attribute_value
from mgk_yrp.tests.fixtures import make_item_attribute, make_item_group, make_uom


def make_item_with(attribute):
	name = f"MGK Attribute Item {frappe.generate_hash(length=8)}"
	return (
		frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": name,
				"item_name": name,
				"item_group": make_item_group(),
				"stock_uom": make_uom("Nos"),
				"is_stock_item": 1,
				"has_variants": 1,
				"attributes": [attribute],
			}
		)
		.insert(ignore_permissions=True)
		.name
	)


def item_values(item):
	return get_mapping_values(frappe.get_doc("Item", item).attributes[0].mapping)


class TestCreateAttributeValue(IntegrationTestCase):
	def test_new_value_is_created_and_appended_to_explicit_mapping(self):
		attribute, existing = make_item_attribute()
		item = make_item_with(attribute)
		self.assertEqual(create_attribute_value(item, attribute["attribute"], " Grey "), "Grey")
		self.assertTrue(
			frappe.db.exists(
				"YRP Item Attribute Value",
				{"attribute_name": attribute["attribute"], "attribute_value": "Grey"},
			)
		)
		self.assertEqual(item_values(item), [existing, "Grey"])
		self.assertEqual(search_item_attribute_values("grey", attribute["attribute"], item), ["Grey"])

	def test_repeat_call_is_idempotent(self):
		attribute, existing = make_item_attribute()
		item = make_item_with(attribute)
		create_attribute_value(item, attribute["attribute"], "Grey")
		create_attribute_value(item, attribute["attribute"], "Grey")
		self.assertEqual(item_values(item), [existing, "Grey"])
		self.assertEqual(
			frappe.db.count(
				"YRP Item Attribute Value",
				{"attribute_name": attribute["attribute"], "attribute_value": "Grey"},
			),
			1,
		)

	def test_existing_global_value_is_only_added_to_mapping(self):
		attribute, existing = make_item_attribute()
		item = make_item_with(attribute)
		ensure_global_attribute_values(attribute["attribute"], ["Navy"], check_permission=False)
		self.assertEqual(create_attribute_value(item, attribute["attribute"], "Navy"), "Navy")
		self.assertEqual(item_values(item), [existing, "Navy"])
		self.assertEqual(
			frappe.db.count(
				"YRP Item Attribute Value",
				{"attribute_name": attribute["attribute"], "attribute_value": "Navy"},
			),
			1,
		)

	def test_empty_mapping_allows_all_values_and_stays_empty(self):
		attribute, _ = make_item_attribute()
		item = make_item_with({"attribute": attribute["attribute"]})
		create_attribute_value(item, attribute["attribute"], "Grey")
		self.assertEqual(search_item_attribute_values("grey", attribute["attribute"], item), ["Grey"])
		self.assertEqual(item_values(item), [])

	def test_attribute_must_belong_to_item(self):
		attribute, _ = make_item_attribute()
		other, _ = make_item_attribute()
		item = make_item_with(attribute)
		with self.assertRaises(frappe.ValidationError):
			create_attribute_value(item, other["attribute"], "Grey")
		self.assertFalse(
			frappe.db.exists(
				"YRP Item Attribute Value", {"attribute_name": other["attribute"], "attribute_value": "Grey"}
			)
		)

	def test_create_permission_is_required(self):
		attribute, _ = make_item_attribute()
		item = make_item_with(attribute)
		with (
			patch("mgk_yrp.stock.attribute_values.frappe.has_permission", side_effect=frappe.PermissionError),
			self.assertRaises(frappe.PermissionError),
		):
			create_attribute_value(item, attribute["attribute"], "Grey")
		self.assertEqual(len(item_values(item)), 1)
