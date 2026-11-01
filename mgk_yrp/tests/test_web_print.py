from unittest.mock import patch

import frappe
from frappe.custom.doctype.property_setter.property_setter import make_property_setter
from frappe.tests import IntegrationTestCase

from mgk_yrp.tests.fixtures import make_item, make_purchase_order, make_supplier, make_uom, make_warehouse
from mgk_yrp.web import boot
from mgk_yrp.web.print import get_print_options

ORDER = "MGK Purchase Order"


class TestWebPrint(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.enterContext(patch("frappe.enqueue"))
		self.addCleanup(frappe.set_user, frappe.session.user)
		self.addCleanup(frappe.clear_cache, doctype=ORDER)
		frappe.set_user("Administrator")
		location = make_supplier(is_company_location=1)
		self.order = make_purchase_order(
			supplier=make_supplier(),
			warehouse=make_warehouse(supplier=location),
			items=[{"item": make_item(stock_uom=make_uom("Kg")), "qty": 1, "rate": 10}],
		)

	def make_format(self, name, disabled=0):
		frappe.get_doc(
			{
				"doctype": "Print Format",
				"name": name,
				"doc_type": ORDER,
				"module": "Mgk Yrp",
				"standard": "No",
				"print_format_type": "Jinja",
				"custom_format": 1,
				"html": "<p>{{ doc.name }}</p>",
				"disabled": disabled,
			}
		).insert(ignore_if_duplicate=True)

	def make_letter_head(self, name, is_default=0, disabled=0):
		frappe.get_doc(
			{
				"doctype": "Letter Head",
				"letter_head_name": name,
				"source": "HTML",
				"content": name,
				"is_default": is_default,
				"disabled": disabled,
			}
		).insert(ignore_if_duplicate=True)

	def test_lists_enabled_formats_and_letter_heads_with_desk_defaults(self):
		self.make_format("MGK Test PO Print")
		self.make_format("MGK Test PO Disabled", disabled=1)
		self.make_letter_head("MGK Test Head", is_default=1)
		self.make_letter_head("MGK Test Old Head", disabled=1)
		make_property_setter(
			ORDER, None, "default_print_format", "MGK Test PO Print", "Data", for_doctype=True
		)
		frappe.clear_cache(doctype=ORDER)
		options = get_print_options(ORDER, self.order.name)
		self.assertIn("Standard", options["formats"])
		self.assertIn("MGK Test PO Print", options["formats"])
		self.assertNotIn("MGK Test PO Disabled", options["formats"])
		self.assertEqual(options["default_format"], "MGK Test PO Print")
		self.assertIn("MGK Test Head", options["letter_heads"])
		self.assertNotIn("MGK Test Old Head", options["letter_heads"])
		self.assertEqual(options["default_letter_head"], "MGK Test Head")

	def test_defaults_to_standard_without_a_doctype_default(self):
		frappe.db.set_value("Letter Head", {"is_default": 1}, "is_default", 0)
		options = get_print_options(ORDER, self.order.name)
		self.assertEqual(options["default_format"], "Standard")
		self.assertEqual(options["default_letter_head"], "")

	def test_requires_print_permission(self):
		with patch("frappe.has_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				get_print_options(ORDER, self.order.name)

	def test_boot_recomputes_print_permission(self):
		self.assertIn("print", boot.PERMISSION_TYPES)
