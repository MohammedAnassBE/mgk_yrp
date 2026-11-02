from unittest import TestCase

import frappe
from frappe.desk.search import search_link

TAMIL_NAME_DOCTYPES = ("Item", "Supplier", "Warehouse", "MGK Agent", "YRP Process", "Item Group")
BASE_SEARCH_FIELDS = {
	"Item": ["item_name", "description", "item_group", "customer_code"],
	"Supplier": ["supplier_group", "alias"],
	"MGK Agent": ["agent_name"],
	"Item Group": ["parent_item_group"],
}


class TestTamilSearch(TestCase):
	def tearDown(self):
		frappe.db.rollback()

	def test_tamil_name_is_a_search_field_and_existing_ones_are_kept(self):
		for doctype in TAMIL_NAME_DOCTYPES:
			fields = frappe.get_meta(doctype).get_search_fields()
			self.assertIn("mgk_tamil_name", fields, doctype)
			for fieldname in BASE_SEARCH_FIELDS.get(doctype, []):
				self.assertIn(fieldname, fields, doctype)

	def test_search_link_finds_supplier_by_tamil_name(self):
		supplier = frappe.get_doc(
			{"doctype": "Supplier", "supplier_name": "Tamil Search Supplier", "mgk_tamil_name": "தேடல் சப்ளையர்"}
		).insert(ignore_permissions=True)
		values = [row["value"] for row in search_link("Supplier", "தேடல்")]
		self.assertIn(supplier.name, values)

	def test_search_link_finds_agent_by_tamil_name(self):
		agent = frappe.get_doc(
			{"doctype": "MGK Agent", "agent_name": "Tamil Search Agent", "mgk_tamil_name": "தேடல் முகவர்"}
		).insert(ignore_permissions=True)
		values = [row["value"] for row in search_link("MGK Agent", "முகவர்")]
		self.assertIn(agent.name, values)
