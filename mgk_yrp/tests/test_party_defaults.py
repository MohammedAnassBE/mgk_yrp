from unittest.mock import Mock, patch

import frappe
from frappe.tests import IntegrationTestCase

from mgk_yrp.party_defaults import get_own_location, get_party_defaults
from mgk_yrp.tests.fixtures import make_supplier, make_warehouse

MODULE = "mgk_yrp.party_defaults"


class TestPartyDefaults(IntegrationTestCase):
	def test_single_warehouse_is_filled_and_multiple_candidates_are_not(self):
		supplier = make_supplier()
		first = make_warehouse(supplier=supplier)
		result = get_party_defaults(supplier)
		self.assertEqual(result["warehouses"], [first])
		self.assertEqual(result["warehouse"], first)
		second = make_warehouse(supplier=supplier)
		result = get_party_defaults(supplier)
		self.assertEqual(set(result["warehouses"]), {first, second})
		self.assertIsNone(result["warehouse"])

	def test_disabled_and_group_warehouses_are_excluded(self):
		supplier = make_supplier()
		active, disabled, group = [make_warehouse(supplier=supplier) for _ in range(3)]
		frappe.db.set_value("Warehouse", disabled, "disabled", 1)
		frappe.db.set_value("Warehouse", group, "is_group", 1)
		self.assertEqual(get_party_defaults(supplier)["warehouses"], [active])

	def test_supplier_permission_is_checked_before_candidates(self):
		document = Mock()
		document.check_permission.side_effect = frappe.PermissionError
		with (
			patch(f"{MODULE}.frappe.get_doc", return_value=document),
			patch(f"{MODULE}.frappe.get_list") as query,
			self.assertRaises(frappe.PermissionError),
		):
			get_party_defaults("forbidden")
		query.assert_not_called()
		document.check_permission.assert_called_once_with("read")

	def make_address(self, supplier, *, preferred=False):
		return frappe.get_doc(
			{
				"doctype": "Address",
				"address_title": f"MGK Web {frappe.generate_hash(length=8)}",
				"address_type": "Billing",
				"address_line1": "Test Road",
				"city": "Tiruppur",
				"country": "India",
				"is_primary_address": int(preferred),
				"links": [{"link_doctype": "Supplier", "link_name": supplier}],
			}
		).insert(ignore_permissions=True)

	def test_unique_and_preferred_addresses_and_ambiguous_candidates(self):
		supplier = make_supplier()
		first = self.make_address(supplier)
		self.assertEqual(get_party_defaults(supplier)["address"], first.name)
		second = self.make_address(supplier)
		result = get_party_defaults(supplier)
		self.assertEqual(set(result["addresses"]), {first.name, second.name})
		self.assertIsNone(result["address"])
		frappe.db.set_value("Address", second.name, "is_primary_address", 1)
		self.assertEqual(get_party_defaults(supplier)["address"], second.name)

	def test_contacts_are_unique_or_primary_and_never_unrelated(self):
		supplier, other = make_supplier(), make_supplier()

		def contact(party, primary=0):
			return frappe.get_doc(
				{
					"doctype": "Contact",
					"first_name": f"MGK {frappe.generate_hash(length=8)}",
					"is_primary_contact": primary,
					"links": [{"link_doctype": "Supplier", "link_name": party}],
				}
			).insert(ignore_permissions=True)

		first = contact(supplier)
		unrelated = contact(other)
		self.assertEqual(get_party_defaults(supplier)["contact"], first.name)
		second = contact(supplier)
		self.assertIsNone(get_party_defaults(supplier)["contact"])
		frappe.db.set_value("Contact", second.name, "is_primary_contact", 1)
		result = get_party_defaults(supplier)
		self.assertEqual(result["contact"], second.name)
		self.assertNotIn(unrelated.name, result["contacts"])

	def test_settings_empty_and_configured_location(self):
		with patch(f"{MODULE}.frappe.db.get_single_value", return_value=None):
			self.assertEqual(get_own_location(), {"location": None, "warehouse": None, "warehouses": []})
		supplier = make_supplier()
		warehouse = make_warehouse(supplier=supplier)
		with patch(f"{MODULE}.frappe.db.get_single_value", return_value=supplier):
			self.assertEqual(
				get_own_location(), {"location": supplier, "warehouse": warehouse, "warehouses": [warehouse]}
			)

	def test_candidate_queries_are_permission_aware(self):
		with (
			patch(f"{MODULE}.frappe.get_doc"),
			patch(f"{MODULE}.frappe.get_list", return_value=[]) as query,
		):
			get_party_defaults("Supplier A")
		self.assertEqual(
			[entry.args[0] for entry in query.call_args_list], ["Warehouse", "Address", "Contact"]
		)
		for entry in query.call_args_list:
			self.assertFalse(entry.kwargs.get("ignore_permissions"))
