import json
from pathlib import Path
from unittest import TestCase

import frappe

TAMIL_NAMES = {
	"Item": ("Item Name (Tamil)", "item_name"),
	"Supplier": ("Supplier Name (Tamil)", "supplier_name"),
	"Warehouse": ("Warehouse Name (Tamil)", "warehouse_name"),
	"YRP Process": ("Process Name (Tamil)", "process_name"),
	"Item Group": ("Item Group Name (Tamil)", "item_group_name"),
}
FIXTURE = Path(__file__).parents[1] / "fixtures" / "custom_field.json"


class TestTamilNames(TestCase):
	def test_fixture_ships_tamil_name_fields_under_mgk_module(self):
		fields = {row["name"]: row for row in json.loads(FIXTURE.read_text())}
		for doctype, (label, insert_after) in TAMIL_NAMES.items():
			field = fields[f"{doctype}-mgk_tamil_name"]
			self.assertEqual(field["module"], "MGK YRP")
			self.assertEqual(
				(field["fieldtype"], field["label"], field["insert_after"]), ("Data", label, insert_after)
			)

	def test_every_mgk_master_has_a_tamil_name_column(self):
		for doctype in [*TAMIL_NAMES, "MGK Agent"]:
			self.assertTrue(frappe.get_meta(doctype).has_field("mgk_tamil_name"), doctype)
			self.assertTrue(frappe.db.has_column(doctype, "mgk_tamil_name"), doctype)

	def test_tamil_name_round_trips_on_a_supplier(self):
		supplier = frappe.get_doc(
			{
				"doctype": "Supplier",
				"supplier_name": "Tamil Name Test Supplier",
				"mgk_tamil_name": "தமிழ் சப்ளையர்",
			}
		)
		supplier.insert(ignore_permissions=True)
		try:
			self.assertEqual(frappe.db.get_value("Supplier", supplier.name, "mgk_tamil_name"), "தமிழ் சப்ளையர்")
		finally:
			frappe.delete_doc("Supplier", supplier.name, force=True, ignore_permissions=True)
			frappe.db.rollback()
