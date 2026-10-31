from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from mgk_yrp import hooks
from mgk_yrp.stock.locking import LOCK_ORDER, lock_documents
from mgk_yrp.stock.uom import copy_uom_snapshot, validate_uom_snapshot
from mgk_yrp.stock.warehouse import get_supplier_warehouse
from mgk_yrp.tests.fixtures import (
	get_company,
	make_address,
	make_contact,
	make_item,
	make_supplier,
	make_uom,
	make_warehouse,
	set_mgk_settings,
)


class TestSetup(IntegrationTestCase):
	def test_custom_fields_and_property_setter_exist(self):
		self.assertEqual(hooks.required_apps, ["frappe", "erpnext", "yrp"])
		self.assertEqual(hooks.doc_events["Item"]["validate"], "mgk_yrp.overrides.item.validate")
		self.assertEqual(hooks.app_include_js, ["mgk_yrp.bundle.js"])
		self.assertEqual(
			{fixture["dt"] for fixture in hooks.fixtures}, {"Custom Field", "Property Setter", "Item Group", "YRP UI Layout"}
		)
		self.assertEqual(frappe.db.get_value("Custom Field", "Item-mgk_gst_tax_slab", "module"), "MGK YRP")
		for group in ("Karigan Items", "Salavai Cone Items"):
			self.assertEqual(
				frappe.db.get_value("Item Group", group, ["parent_item_group", "is_group"]), ("All Item Groups", 0)
			)
		self.assertEqual(frappe.get_meta("Item").get_field("mgk_gst_tax_slab").options, "YRP Tax Slab")
		options = frappe.get_meta("YRP Stock Valuation Adjustment").get_field("adjustment_type").options
		self.assertEqual(
			options.splitlines(),
			[
				"Purchase Invoice Rate Difference",
				"Work Order Excess Usage",
				"Reversal",
				"Delivery Challan Close",
			],
		)

	def test_agent_naming_series(self):
		agent = frappe.get_doc(
			{
				"doctype": "MGK Agent",
				"agent_name": f"MGK Test Agent {frappe.generate_hash(length=8)}",
			}
		).insert(ignore_permissions=True)
		self.assertRegex(agent.name, r"^AG-\d{5,}$")
		address = make_address("MGK Agent", agent.name)
		contact = make_contact("MGK Agent", agent.name)
		agent.onload()
		self.assertIn(address, [row.name for row in agent.get_onload().addr_list])
		self.assertIn(contact, [row.name for row in agent.get_onload().contact_list])
		agent.delete(ignore_permissions=True)
		self.assertFalse(frappe.db.exists("Address", address))
		self.assertFalse(frappe.db.exists("Contact", contact))

	def test_settings_rejects_bad_gstin(self):
		settings = frappe.get_single("MGK Settings")
		settings.company = get_company()
		for gstin in ("ABC", "33AAAAA0000A1X5", "33AAAAA0000A0Z5"):
			with self.subTest(gstin=gstin), self.assertRaises(frappe.ValidationError):
				settings.company_gstin = gstin
				settings.save(ignore_permissions=True)
		set_mgk_settings()
		settings.reload()
		self.assertEqual(settings.company_state_code, "33")

	def test_lock_documents_uses_parent_order_then_sorted_names(self):
		documents = {doctype: ["B", "A", "A", ""] for doctype in reversed(LOCK_ORDER)}
		with patch("mgk_yrp.stock.locking.frappe.db.sql") as query:
			lock_documents(documents)
		self.assertEqual(query.call_count, len(LOCK_ORDER) * 2)
		for index, doctype in enumerate(LOCK_ORDER):
			for offset, name in enumerate(("A", "B")):
				statement, parameters = query.call_args_list[index * 2 + offset].args
				self.assertIn(f"`tab{doctype}`", statement)
				self.assertTrue(statement.endswith("FOR UPDATE"))
				self.assertEqual(parameters, (name,))
		with self.assertRaises(ValueError):
			lock_documents({"Item": ["A"]})

	def test_linked_uom_snapshot_is_copied_and_validated(self):
		source = frappe._dict(uom="Bag", stock_uom="Kg", conversion_factor=50)
		row = frappe.get_doc({"doctype": "MGK Purchase Order Item", "idx": 2, "qty": 3})
		copy_uom_snapshot(row, source)
		self.assertEqual(row.stock_qty, 150)
		validate_uom_snapshot(row, source, "Source receipt")
		for fieldname, value in (("uom", "Nos"), ("stock_uom", "Nos"), ("conversion_factor", 1)):
			with self.subTest(fieldname=fieldname):
				copy_uom_snapshot(row, source)
				row.set(fieldname, value)
				with self.assertRaisesRegex(frappe.ValidationError, "Source receipt: row 2"):
					validate_uom_snapshot(row, source, "Source receipt")

	def test_supplier_warehouse_requires_exactly_one_enabled_match(self):
		supplier = make_supplier()
		self.assertIsNone(get_supplier_warehouse(None))
		self.assertIsNone(get_supplier_warehouse(supplier))
		warehouse = make_warehouse(supplier=supplier)
		self.assertEqual(get_supplier_warehouse(supplier), warehouse)
		second = make_warehouse(supplier=supplier)
		self.assertIsNone(get_supplier_warehouse(supplier))
		frappe.db.set_value("Warehouse", second, "disabled", 1)
		self.assertEqual(get_supplier_warehouse(supplier), warehouse)
