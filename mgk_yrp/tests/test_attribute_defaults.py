import frappe
from frappe.tests import IntegrationTestCase
from yrp.yrp.doctype.yrp_item.yrp_item import ensure_global_attribute_values, get_or_create_variant

from mgk_yrp.stock.attribute_defaults import (
	fill_entry_defaults,
	get_attribute_defaults,
	get_attribute_details,
	search_default_values,
)
from mgk_yrp.tests.fixtures import make_item_attribute, make_item_group, make_uom


def make_template(attributes, primary=None):
	name = f"MGK Default Template {frappe.generate_hash(length=8)}"
	return frappe.get_doc({
		"doctype": "Item", "item_code": name, "item_name": name, "item_group": make_item_group(),
		"stock_uom": make_uom("Nos"), "is_stock_item": 1, "has_variants": 1,
		"primary_attribute": primary, "attributes": attributes,
	}).insert(ignore_permissions=True)


class TestAttributeDefaults(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.size, self.small = make_item_attribute()
		self.colour, self.red = make_item_attribute()

	def test_default_must_be_an_allowed_value(self):
		with self.assertRaisesRegex(frappe.ValidationError, "is not an allowed value"):
			make_template([self.size, {**self.colour, "mgk_default_value": "Missing"}])

	def test_default_outside_explicit_mapping_is_rejected(self):
		ensure_global_attribute_values(self.colour["attribute"], ["Navy"], check_permission=False)
		with self.assertRaisesRegex(frappe.ValidationError, "is not an allowed value"):
			make_template([{**self.colour, "mgk_default_value": "Navy"}])

	def test_empty_mapping_allows_any_global_value(self):
		ensure_global_attribute_values(self.colour["attribute"], ["Navy"], check_permission=False)
		template = make_template([{"attribute": self.colour["attribute"], "mgk_default_value": "Navy"}])
		self.assertEqual(get_attribute_defaults(template.name), {self.colour["attribute"]: "Navy"})

	def test_primary_attribute_cannot_have_default(self):
		with self.assertRaisesRegex(frappe.ValidationError, "primary attribute"):
			make_template([{**self.size, "mgk_default_value": self.small}, self.colour], self.size["attribute"])

	def test_details_payload_includes_defaults_for_template_and_variant(self):
		template = make_template([self.size, {**self.colour, "mgk_default_value": self.red}], self.size["attribute"])
		expected = {self.colour["attribute"]: self.red}
		self.assertEqual(get_attribute_details(template.name)["attribute_defaults"], expected)
		self.assertEqual(get_attribute_details(template.name)["primary_attribute"], self.size["attribute"])
		variant = get_or_create_variant(template.name, {self.size["attribute"]: self.small, self.colour["attribute"]: self.red})
		self.assertEqual(get_attribute_details(variant)["attribute_defaults"], expected)

	def test_item_without_defaults_returns_empty_defaults(self):
		template = make_template([self.size, self.colour])
		self.assertEqual(get_attribute_details(template.name)["attribute_defaults"], {})

	def test_fill_entry_defaults_only_fills_blanks(self):
		template = make_template([{**self.size, "mgk_default_value": self.small}, {**self.colour, "mgk_default_value": self.red}])
		groups = [{"items": [{"name": template.name, "attributes": {self.size["attribute"]: "Picked", self.colour["attribute"]: ""}}]}]
		fill_entry_defaults(groups)
		self.assertEqual(groups[0]["items"][0]["attributes"], {self.size["attribute"]: "Picked", self.colour["attribute"]: self.red})

	def test_desk_search_returns_value_labels(self):
		template = make_template([self.colour])
		self.assertEqual(search_default_values("", self.colour["attribute"], template.name), [{"value": self.red, "label": self.red}])
