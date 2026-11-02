from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import formatdate, nowdate
from yrp.yrp.doctype.yrp_item.yrp_item import create_variant

from mgk_yrp.print_helpers import get_print_items, get_print_name
from mgk_yrp.tests.fixtures import (
	make_address,
	make_delivery_challan,
	make_item,
	make_po_grn,
	make_purchase_order,
	make_received_type,
	make_supplier,
	make_template_item,
	make_uom,
	make_warehouse,
)

FORMATS = ("MGK Purchase Order", "MGK Delivery Challan", "MGK Goods Received Note")
TAMIL_PO = "MGK Purchase Order (Tamil)"


class TestPrintFormats(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.enterContext(patch("frappe.enqueue"))
		self.addCleanup(frappe.set_user, frappe.session.user)
		frappe.set_user("Administrator")
		self.template, attributes = make_template_item()
		self.attribute, self.value = next(iter(attributes.items()))
		self.variant = create_variant(self.template.name, attributes).insert(ignore_permissions=True).name
		self.plain = make_item(stock_uom=make_uom("Kg"))
		self.supplier = make_supplier()
		make_address("Supplier", self.supplier)
		self.location = make_supplier(is_company_location=1)
		self.warehouse = make_warehouse(supplier=self.location)
		self.order = make_purchase_order(
			supplier=self.supplier,
			warehouse=self.warehouse,
			items=[{"item": self.variant, "qty": 4, "rate": 25}, {"item": self.plain, "qty": 2, "rate": 10}],
		)

	def test_formats_are_standard_and_doctype_defaults(self):
		for doctype in FORMATS:
			for name in (doctype, f"{doctype} (Tamil)"):
				values = frappe.db.get_value(
					"Print Format", name, ["doc_type", "standard", "module"], as_dict=True
				)
				self.assertEqual(
					(values.doc_type, values.standard, values.module), (doctype, "Yes", "MGK YRP")
				)
			self.assertEqual(frappe.get_meta(doctype).default_print_format, doctype)

	def test_items_split_template_and_attribute_columns(self):
		items = get_print_items(self.order)
		self.assertEqual(items["attributes"], [self.attribute])
		self.assertTrue(items["has_received_type"])
		self.assertEqual(items["rows"][0]["item_template"], self.template.name)
		self.assertEqual(items["rows"][1]["item_attributes"], {})
		self.assertEqual((items["total_qty"], items["total_amount"]), (6, 120))

	def assert_rendered(self, doc, *expected):
		html = frappe.get_print(doc.doctype, doc.name, print_format=doc.doctype)
		for text in (self.template.name, self.attribute, self.value, make_received_type(), *expected):
			self.assertIn(frappe.utils.escape_html(text), html)
		self.assertNotIn(f">{self.variant}<", html)
		self.assertIn(formatdate(nowdate(), "dd-mm-yyyy"), html)

	def test_purchase_order_renders(self):
		self.assert_rendered(self.order, "PURCHASE ORDER", self.supplier, "MGK Test Street", "120.00")

	def test_goods_received_note_renders(self):
		receipt = make_po_grn(self.order)
		self.assert_rendered(receipt, "GOODS RECEIVED NOTE", self.order.name, "MGK Test Street")

	def test_draft_delivery_challan_renders(self):
		challan = make_delivery_challan(
			from_warehouse=self.warehouse,
			to_supplier=self.supplier,
			to_warehouse=make_warehouse(supplier=self.supplier),
			items=[{"item": self.variant, "qty": 3, "rate": 5}],
			submit=False,
		)
		self.assert_rendered(challan, "DELIVERY CHALLAN", challan.process_name, "DRAFT", "MGK Test Street")

	def test_tamil_purchase_order_uses_tamil_labels_names_and_font(self):
		frappe.db.set_value("Item", self.template.name, "mgk_tamil_name", "சோதனை நூல்")
		frappe.db.set_value("Supplier", self.supplier, "mgk_tamil_name", "சோதனை சப்ளையர்")
		html = frappe.get_print(self.order.doctype, self.order.name, print_format=TAMIL_PO)
		for text in ("கொள்முதல் ஆணை", "சோதனை நூல்", "சோதனை சப்ளையர்", "MGK Noto Sans Tamil", "base64,"):
			self.assertIn(text, html)
		self.assertNotIn("PURCHASE ORDER", html)
		self.assertNotIn(f">{self.template.name}<", html)

	def test_tamil_names_fall_back_to_english(self):
		self.assertEqual(get_print_name("Supplier", self.supplier, tamil=1), self.supplier)
		self.assertEqual(
			get_print_name("Warehouse", self.warehouse, tamil=1),
			frappe.db.get_value("Warehouse", self.warehouse, "warehouse_name"),
		)
		self.assertEqual(get_print_name("Supplier", None, tamil=1), "")
