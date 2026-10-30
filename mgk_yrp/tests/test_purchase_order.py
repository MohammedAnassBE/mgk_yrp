from unittest.mock import PropertyMock, patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import nowdate

from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import MGKPurchaseOrder, get_item_uom
from mgk_yrp.tests.fixtures import (
	get_company,
	make_address,
	make_contact,
	make_item,
	make_purchase_order,
	make_supplier,
	make_tax_slab,
	make_uom,
	make_warehouse,
)


class TestPurchaseOrder(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.supplier = make_supplier()
		self.warehouse = make_warehouse(supplier=make_supplier(is_company_location=1))
		self.stock_uom = make_uom("Kg")
		self.item = make_item(stock_uom=self.stock_uom)

	def make_order(self, items=None, **header):
		return make_purchase_order(
			supplier=self.supplier,
			warehouse=header.pop("warehouse", self.warehouse),
			items=items if items is not None else [{"item": self.item, "qty": 2, "rate": 123.45}],
			submit=header.pop("submit", False),
			**header,
		)

	def test_po_autofills_supplier_address_and_contact(self):
		address = make_address("Supplier", self.supplier)
		contact = make_contact("Supplier", self.supplier)
		order = self.make_order()
		self.assertEqual(order.supplier_address, address)
		self.assertIn("MGK Test Street", order.address_display)
		self.assertEqual(order.contact_person, contact)
		self.assertEqual(order.contact_display, frappe.db.get_value("Contact", contact, "full_name"))
		self.assertEqual(order.contact_mobile, "9876543210")
		foreign_supplier = make_supplier()
		order.supplier_address = make_address("Supplier", foreign_supplier)
		order.contact_person = make_contact("Supplier", foreign_supplier)
		order.save()
		self.assertEqual(order.supplier_address, address)
		self.assertEqual(order.contact_person, contact)

	def test_u6_company_location_supplier_rejected_on_new_and_draft_save(self):
		order = self.make_order()
		frappe.db.set_value("Supplier", self.supplier, "is_company_location", 1)
		for save in (lambda: self.make_order(), order.save):
			with self.assertRaisesRegex(frappe.ValidationError, "is a company location; use a Delivery Challan"):
				save()

	def test_u6_legacy_submitted_order_can_save_and_cancel(self):
		order = self.make_order(submit=True)
		frappe.db.set_value("Supplier", self.supplier, "is_company_location", 1)
		order.reload().save()
		order.cancel()
		self.assertEqual(order.reload().docstatus, 2)

	def test_po_keeps_user_selected_linked_address_and_contact(self):
		make_address("Supplier", self.supplier)
		make_contact("Supplier", self.supplier)
		address = make_address("Supplier", self.supplier)
		contact = make_contact("Supplier", self.supplier)
		frappe.db.set_value("Address", address, "is_primary_address", 0)
		frappe.db.set_value("Contact", contact, "is_primary_contact", 0)
		order = self.make_order(supplier_address=address, contact_person=contact)
		self.assertEqual(order.supplier_address, address)
		self.assertEqual(order.contact_person, contact)

	def test_po_defaults_warehouse_from_delivery_location(self):
		location = make_supplier(is_company_location=1)
		warehouse = make_warehouse(supplier=location)
		order = self.make_order(warehouse=None, delivery_location=location)
		self.assertEqual(order.warehouse, warehouse)
		order = self.make_order(warehouse=self.warehouse, delivery_location=location)
		self.assertEqual(order.warehouse, self.warehouse)

	def test_through_vendor_requires_handling_supplier(self):
		with self.assertRaisesRegex(frappe.ValidationError, "Handling Supplier"):
			self.make_order(goods_routing="Through Vendor")
		vendor = make_supplier()
		order = self.make_order(goods_routing="Through Vendor", handling_supplier=vendor)
		self.assertEqual(order.handling_supplier, vendor)
		order.goods_routing = "Direct"
		order.save()
		self.assertFalse(order.handling_supplier)

	def test_karigan_and_salavai_are_exclusive(self):
		with self.assertRaisesRegex(frappe.ValidationError, "both"):
			self.make_order(is_karigan_order=1, is_salavai_cone_order=1)

	def test_karigan_order_rejects_unclassified_item(self):
		with self.assertRaisesRegex(frappe.ValidationError, "book"):
			self.make_order(is_karigan_order=1)
		item = make_item(stock_uom=self.stock_uom, is_karigan=1)
		order = self.make_order(items=[{"item": item, "qty": 1, "rate": 10}], is_karigan_order=1)
		self.assertEqual(order.items[0].item, item)

	def test_other_order_rejects_classified_item(self):
		for classification in ({"is_karigan": 1}, {"is_salavai_cone": 1}):
			with self.subTest(classification=classification):
				item = make_item(stock_uom=self.stock_uom, **classification)
				with self.assertRaisesRegex(frappe.ValidationError, "book"):
					self.make_order(items=[{"item": item, "qty": 1, "rate": 10}])

	def test_salavai_order_accepts_only_salavai_items(self):
		item = make_item(stock_uom=self.stock_uom, is_salavai_cone=1)
		order = self.make_order(items=[{"item": item, "qty": 1, "rate": 10}], is_salavai_cone_order=1)
		self.assertEqual(order.items[0].item, item)
		for header in ({"is_salavai_cone_order": 1}, {"is_karigan_order": 1}):
			with self.subTest(header=header), self.assertRaisesRegex(frappe.ValidationError, "book"):
				self.make_order(
					items=[
						{
							"item": self.item if header.get("is_salavai_cone_order") else item,
							"qty": 1,
							"rate": 10,
						}
					],
					**header,
				)

	def test_po_rate_is_user_typed_and_kept(self):
		self.make_item_prices()
		order = self.make_order(
			items=[
				{"item": self.item, "qty": 2, "rate": 123.45},
				{"item": self.item, "qty": 3, "rate": 10},
			]
		)
		order.save()
		order.submit()
		order.reload()
		self.assertEqual(order.items[0].rate, 123.45)
		self.assertEqual(order.items[0].amount, 246.9)
		self.assertEqual(order.total_qty, 5)
		self.assertEqual(order.total_amount, 276.9)

	def make_item_prices(self):
		name = f"MGK Test Price List {frappe.generate_hash(length=8)}"
		currency = frappe.db.get_value("Company", get_company(), "default_currency")
		price_list = frappe.get_doc(
			{
				"doctype": "Price List",
				"price_list_name": name,
				"enabled": 1,
				"buying": 1,
				"currency": currency,
			}
		).insert(ignore_permissions=True)
		frappe.get_doc(
			{
				"doctype": "Item Price",
				"item_code": self.item,
				"price_list": price_list.name,
				"supplier": self.supplier,
				"uom": self.stock_uom,
				"price_list_rate": 99,
			}
		).insert(ignore_permissions=True)
		frappe.get_doc(
			{
				"doctype": "YRP Item Price",
				"item_name": self.item,
				"supplier": self.supplier,
				"uom": self.stock_uom,
				"from_date": nowdate(),
				"tax": make_tax_slab("0"),
				"item_price_values": [{"moq": 0, "price": 99, "lead_time": 0}],
			}
		).insert(ignore_permissions=True)

	def test_po_uom_resolves_from_item(self):
		make_uom("Nos")
		order = self.make_order(
			items=[
				{
					"item": self.item,
					"qty": 2,
					"rate": 10,
					"uom": "Nos",
					"stock_uom": "Nos",
					"conversion_factor": 99,
				}
			]
		)
		row = order.items[0]
		self.assertEqual(row.uom, self.stock_uom)
		self.assertEqual(row.stock_uom, self.stock_uom)
		self.assertEqual(row.conversion_factor, 1)
		self.assertEqual(row.stock_qty, 2)
		self.assertEqual(get_item_uom(self.item).uom, self.stock_uom)

	def test_po_rejects_zero_qty_and_rate(self):
		for quantity, rate in ((0, 10), (1, 0), (-1, 10), (1, -10)):
			with self.subTest(quantity=quantity, rate=rate):
				with self.assertRaisesRegex(frappe.ValidationError, "greater than zero"):
					self.make_order(items=[{"item": self.item, "qty": quantity, "rate": rate}])

	def test_po_uom_resolves_variant_purchase_uom_from_parent_mapping(self):
		item = make_item(
			stock_uom=self.stock_uom, purchase_uom=make_uom("Bag"), conversion_factor=50, is_karigan=1
		)
		order = self.make_order(items=[{"item": item, "qty": 3, "rate": 100}], is_karigan_order=1)
		row = order.items[0]
		self.assertEqual(row.uom, "Bag")
		self.assertEqual(row.stock_uom, self.stock_uom)
		self.assertEqual(row.conversion_factor, 50)
		self.assertEqual(row.stock_qty, 150)
		self.assertEqual(row.rate, 100)
		self.assertEqual(row.amount, 300)
		parent = frappe.db.get_value("Item", item, "variant_of")
		self.assertTrue(parent)
		self.assertTrue(frappe.db.get_value("Item", parent, "mgk_is_karigan"))

	def test_po_status_on_submit_and_cancel(self):
		order = self.make_order()
		self.assertRegex(order.name, r"^MGK-PO-\d{2}-\d{5,}$")
		self.assertEqual(order.status, "Draft")
		order.submit()
		order.reload()
		self.assertEqual(order.status, "To Receive")
		order.cancel()
		order.reload()
		self.assertEqual(order.status, "Cancelled")

	def test_update_received_qty_without_grn_doctype(self):
		order = self.make_order(submit=True)
		with patch("frappe.db.exists", return_value=False):
			order.update_received_qty()
		order.reload()
		self.assertEqual(order.items[0].received_qty, 0)
		self.assertEqual(order.items[0].pending_qty, 2)
		self.assertEqual(order.status, "To Receive")

	def test_po_received_qty_and_status(self):
		order = self.make_order(submit=True)
		for received, pending, status in (
			(1, 1, "Partially Received"),
			(2, 0, "Completed"),
			(3, 0, "Completed"),
			(0, 2, "To Receive"),
		):
			with self.subTest(received=received):
				with patch.object(
					MGKPurchaseOrder,
					"received_quantities",
					new_callable=PropertyMock,
					return_value={order.items[0].name: received},
				):
					order.update_received_qty()
				order.reload()
				self.assertEqual(order.items[0].received_qty, received)
				self.assertEqual(order.items[0].pending_qty, pending)
				self.assertEqual(order.status, status)

	def test_received_quantities_only_counts_submitted_receipts_for_this_order(self):
		order = self.make_order()
		with (
			patch("frappe.db.exists", return_value=True),
			patch(
				"frappe.db.sql",
				return_value=[
					(order.items[0].name, 1),
				],
			) as query,
		):
			self.assertEqual(order.received_quantities, {order.items[0].name: 1})
		statement, parameters = query.call_args.args
		self.assertIn("receipt.docstatus = 1", statement)
		self.assertIn("receipt.purchase_order = %s", statement)
		self.assertEqual(parameters, (order.name,))

	def test_item_uom_requires_read_permission(self):
		with patch("frappe.model.document.Document.check_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				get_item_uom(self.item)
