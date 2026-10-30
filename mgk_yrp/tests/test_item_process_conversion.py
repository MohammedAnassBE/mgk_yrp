import re

import frappe
from frappe.tests import IntegrationTestCase
from yrp.yrp.doctype.yrp_item.yrp_item import create_variant

from mgk_yrp import hooks
from mgk_yrp.stock.process_conversion import get_process_conversion
from mgk_yrp.tests.fixtures import make_item, make_item_attribute, make_item_group, make_process, make_uom


def make_template():
	attribute, value = make_item_attribute()
	name = f"MGK Conversion Template {frappe.generate_hash(length=8)}"
	item = frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": name,
			"item_name": name,
			"item_group": make_item_group(),
			"stock_uom": make_uom("Kg"),
			"has_variants": 1,
			"primary_attribute": attribute["attribute"],
			"attributes": [attribute],
		}
	).insert(ignore_permissions=True)
	return item, {attribute["attribute"]: value}


class TestItemProcessConversion(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.template, self.attributes = make_template()
		self.output = make_item(stock_uom=make_uom("Nos"))
		self.process = make_process()

	def add_conversion(self, doc=None, **values):
		doc = self.template if doc is None else doc
		return doc.append(
			"mgk_process_conversions",
			{"process_name": self.process, "item": self.output, "from_qty": 1, "to_qty": 2, **values},
		)

	def assert_save_error(self, doc, message):
		with self.assertRaisesRegex(frappe.ValidationError, re.escape(message)):
			doc.save(ignore_permissions=True)

	def test_child_doctype_schema(self):
		meta = frappe.get_meta("MGK Item Process Conversion")
		self.assertEqual((meta.module, meta.istable, meta.editable_grid), ("MGK YRP", 1, 1))
		expected = [
			("process_name", "Link", "Process", "YRP Process", 1, 0),
			("item", "Link", "Item", "Item", 1, 0),
			("from_uom", "Link", "From UOM", "UOM", 0, 1),
			("from_qty", "Float", "From Qty", None, 1, 0),
			("to_uom", "Link", "To UOM", "UOM", 0, 1),
			("to_qty", "Float", "To Qty", None, 1, 0),
		]
		actual = [
			(field.fieldname, field.fieldtype, field.label, field.options, field.reqd, field.read_only)
			for field in meta.fields
		]
		self.assertEqual(actual, expected)
		self.assertTrue(all(field.in_list_view for field in meta.fields))
		self.assertEqual(str(meta.get_field("from_qty").default), "1")
		self.assertEqual(meta.get_field("to_uom").fetch_from, "item.stock_uom")

	def test_custom_fields_and_desk_hook(self):
		self.assertEqual(hooks.doctype_js["Item"], "public/js/item.js")
		meta = frappe.get_meta("Item")
		for name in ("mgk_process_conversion_section", "mgk_process_conversions"):
			field = meta.get_field(name)
			self.assertIsNotNone(field)
			self.assertEqual(field.depends_on, "eval:doc.has_variants")
			self.assertEqual(field.no_copy, 1)
			self.assertEqual(frappe.db.get_value("Custom Field", f"Item-{name}", "module"), "MGK YRP")
		section = meta.get_field("mgk_process_conversion_section")
		table = meta.get_field("mgk_process_conversions")
		self.assertFalse(section.label)
		self.assertEqual(table.label, "Process Conversions")
		self.assertEqual((section.fieldtype, section.insert_after), ("Section Break", "variants_section"))
		self.assertEqual((table.fieldtype, table.options), ("Table", "MGK Item Process Conversion"))
		self.assertEqual(table.insert_after, section.fieldname)
		table_index = next(index for index, field in enumerate(meta.fields) if field.fieldname == table.fieldname)
		tab = next(field for field in reversed(meta.fields[:table_index]) if field.fieldtype == "Tab Break")
		self.assertEqual(tab.fieldname, "variants_section")

	def test_variant_does_not_copy_conversions_and_template_can_be_resaved(self):
		settings = frappe.get_doc("Item Variant Settings")
		settings.set_default_fields()
		self.enterContext(
			self.change_settings("Item Variant Settings", fields=settings.fields, do_not_update_variants=0)
		)
		self.add_conversion()
		self.template.save(ignore_permissions=True)
		variant = create_variant(self.template.name, self.attributes)
		self.assertFalse(variant.get("mgk_process_conversions"))
		variant.insert(ignore_permissions=True)
		variant.reload()
		self.assertFalse(variant.get("mgk_process_conversions"))
		variant.save(ignore_permissions=True)
		self.template.save(ignore_permissions=True)
		self.template.reload()
		variant.reload()
		self.assertEqual(len(self.template.mgk_process_conversions), 1)
		self.assertFalse(variant.get("mgk_process_conversions"))

	def test_save_corrects_client_uoms(self):
		self.add_conversion(from_uom="Nos", to_uom="Kg")
		self.template.save(ignore_permissions=True)
		self.template.reload()
		row = self.template.mgk_process_conversions[0]
		self.assertEqual((row.from_uom, row.to_uom), ("Kg", "Nos"))

	def test_save_corrects_uoms_without_framework_link_fetch(self):
		self.add_conversion(from_uom="Nos", to_uom="Kg")
		self.template.flags.ignore_links = True
		self.template.save(ignore_permissions=True)
		self.template.reload()
		row = self.template.mgk_process_conversions[0]
		self.assertEqual((row.from_uom, row.to_uom), ("Kg", "Nos"))

	def test_non_template_with_rows_throws(self):
		item = frappe.get_doc("Item", self.output)
		self.add_conversion(item, item=self.template.name)
		self.assert_save_error(
			item,
			"Process Conversions can be set only on a template Item (Has Variants). Remove the rows first.",
		)

	def test_disabling_has_variants_requires_removing_rows(self):
		self.add_conversion()
		self.template.save(ignore_permissions=True)
		self.template.has_variants = 0
		self.assert_save_error(
			self.template,
			"Process Conversions can be set only on a template Item (Has Variants). Remove the rows first.",
		)

	def test_zero_and_negative_quantities_throw(self):
		for field, quantity in (("from_qty", 0), ("from_qty", -1), ("to_qty", 0), ("to_qty", -1)):
			with self.subTest(field=field, quantity=quantity):
				self.template.reload()
				self.add_conversion(**{field: quantity})
				self.assert_save_error(self.template, "Row 1: From Qty and To Qty must be greater than zero.")

	def test_same_item_allowed(self):
		self.add_conversion(item=self.template.name)
		self.add_conversion()
		self.template.save(ignore_permissions=True)
		self.template.reload()
		self.assertEqual(self.template.mgk_process_conversions[0].item, self.template.name)
		self.assertEqual(self.template.mgk_process_conversions[0].to_uom, "Kg")

	def test_duplicate_process_item_pair_throws(self):
		self.add_conversion()
		self.add_conversion()
		self.assert_save_error(
			self.template, f"Row 2: Process {self.process} to Item {self.output} is already in row 1."
		)

	def test_two_outputs_for_one_process_allowed(self):
		second = make_item(stock_uom="Kg")
		self.add_conversion()
		self.add_conversion(item=second, from_qty=3, to_qty=4)
		self.template.save(ignore_permissions=True)
		self.template.reload()
		self.assertEqual([row.item for row in self.template.mgk_process_conversions], [self.output, second])
		self.assertEqual([row.to_uom for row in self.template.mgk_process_conversions], ["Nos", "Kg"])

	def test_same_output_for_different_processes_allowed(self):
		self.add_conversion()
		self.add_conversion(process_name=make_process())
		self.template.save(ignore_permissions=True)
		self.assertEqual(len(self.template.mgk_process_conversions), 2)

	def test_missing_output_item_throws(self):
		missing = f"MGK Missing Output {frappe.generate_hash(length=8)}"
		self.add_conversion(item=missing)
		self.template.flags.ignore_links = True
		self.assert_save_error(self.template, f"Row 1: Output Item {missing} does not exist.")

	def test_missing_output_link_is_rejected_on_save(self):
		self.add_conversion(item=f"MGK Missing Output {frappe.generate_hash(length=8)}")
		with self.assertRaises(frappe.LinkValidationError):
			self.template.save(ignore_permissions=True)

	def test_empty_output_item_throws(self):
		self.add_conversion(item=None)
		self.assert_save_error(self.template, "Row 1: Output Item is required.")

	def test_helper_returns_ordered_template_rows_for_template_and_variant(self):
		variant = create_variant(self.template.name, self.attributes).insert(ignore_permissions=True)
		second = make_item(stock_uom="Kg")
		self.add_conversion(item=second, from_qty=3, to_qty=4)
		self.add_conversion(process_name=make_process())
		self.add_conversion()
		self.template.save(ignore_permissions=True)
		expected = [
			{
				"process_name": self.process,
				"item": second,
				"from_uom": "Kg",
				"from_qty": 3,
				"to_uom": "Kg",
				"to_qty": 4,
			},
			{
				"process_name": self.process,
				"item": self.output,
				"from_uom": "Kg",
				"from_qty": 1,
				"to_uom": "Nos",
				"to_qty": 2,
			},
		]
		self.assertEqual(get_process_conversion(self.template.name, self.process), expected)
		self.assertEqual(get_process_conversion(variant.name, self.process), expected)
		self.assertEqual(get_process_conversion(variant.name, "MGK Unknown Process"), [])
		self.assertEqual(get_process_conversion(self.output, self.process), [])

	def test_helper_returns_current_output_uom_without_template_resave(self):
		self.add_conversion()
		self.template.save(ignore_permissions=True)
		frappe.db.set_value("Item", self.output, "stock_uom", "Kg")
		self.assertEqual(self.template.mgk_process_conversions[0].to_uom, "Nos")
		rows = get_process_conversion(self.template.name, self.process)
		self.assertEqual(rows[0]["to_uom"], "Kg")

	def test_helper_returns_current_template_uom_without_template_resave(self):
		self.add_conversion()
		self.template.save(ignore_permissions=True)
		frappe.db.set_value("Item", self.template.name, "stock_uom", "Nos")
		self.assertEqual(self.template.mgk_process_conversions[0].from_uom, "Kg")
		rows = get_process_conversion(self.template.name, self.process)
		self.assertEqual(rows[0]["from_uom"], "Nos")
