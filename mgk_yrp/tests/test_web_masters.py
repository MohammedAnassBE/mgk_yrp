from unittest.mock import patch

import frappe
from frappe.client import insert, save
from frappe.tests import IntegrationTestCase

from mgk_yrp.tests.fixtures import make_item_group, make_supplier, make_tax_slab, make_uom
from mgk_yrp.web.master_links import get_link_summaries


class TestWebMasters(IntegrationTestCase):
	def test_link_summaries_are_limited_to_readable_parent_names(self):
		with (
			patch("mgk_yrp.web.master_links.frappe.has_permission", return_value=True),
			patch("mgk_yrp.web.master_links.frappe.get_list", return_value=["Visible"]),
			patch("mgk_yrp.web.master_links.frappe.get_all", return_value=[
				frappe._dict(parent="Visible", link_doctype="Supplier", link_name="Vendor"),
			]) as children,
		):
			self.assertEqual(get_link_summaries("Address", ["Visible", "Hidden"]), {"Visible": "Supplier: Vendor"})
		self.assertEqual(children.call_args.kwargs["filters"]["parent"], ["in", ["Visible"]])
		with self.assertRaises(frappe.ValidationError):
			get_link_summaries("Supplier", [])

	def test_item_client_insert_matches_desk_with_stock_fields_and_gst(self):
		self.addCleanup(frappe.set_user, frappe.session.user)
		frappe.set_user("Administrator")
		payload = {
			"doctype": "Item", "item_code": f"MGK Web Item {frappe.generate_hash(length=8)}",
			"item_name": "Web stock item", "item_group": make_item_group(), "stock_uom": make_uom("Kg"),
			"is_stock_item": 1, "is_purchase_item": 1, "mgk_gst_tax_slab": make_tax_slab("5"),
			"po_excess_allowed_percentage": 2,
		}
		web = insert(payload)
		desk = frappe.get_doc({**payload, "item_code": f"{payload['item_code']} Desk"}).insert().as_dict()
		for field in ("stock_uom", "item_group", "is_stock_item", "is_purchase_item", "mgk_gst_tax_slab", "po_excess_allowed_percentage"):
			self.assertEqual(web[field], desk[field], field)
		self.assertEqual([(row.uom, row.conversion_factor) for row in web.uoms], [(row.uom, row.conversion_factor) for row in desk.uoms])
		web.disabled = 1
		self.assertTrue(save(web).disabled)

	def test_address_client_insert_and_edit_keep_the_real_party_link(self):
		self.addCleanup(frappe.set_user, frappe.session.user)
		frappe.set_user("Administrator")
		for party_type, party_name in (("Supplier", make_supplier()), ("MGK Agent", frappe.get_doc({
			"doctype": "MGK Agent", "agent_name": f"Web Agent {frappe.generate_hash(length=8)}",
		}).insert().name)):
			address = insert({"doctype": "Address", "address_title": party_name, "address_type": "Billing",
				"address_line1": "First road", "city": "Chennai", "country": "India",
				"links": [{"link_doctype": party_type, "link_name": party_name}]})
			address.address_line1 = "Second road"
			address = save(address)
			self.assertEqual(address.address_line1, "Second road")
			self.assertEqual([(row.link_doctype, row.link_name) for row in address.links], [(party_type, party_name)])
			contact = insert({"doctype": "Contact", "first_name": "Web Contact",
				"links": [{"link_doctype": party_type, "link_name": party_name}]})
			contact.last_name = "Updated"
			contact = save(contact)
			self.assertEqual(contact.last_name, "Updated")
			self.assertEqual([(row.link_doctype, row.link_name) for row in contact.links], [(party_type, party_name)])
