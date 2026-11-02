import frappe
from frappe.tests import IntegrationTestCase

from mgk_yrp import hooks
from mgk_yrp.company import set_company


class TestCompany(IntegrationTestCase):
	def test_mgk_documents_get_settings_company(self):
		company = frappe.db.get_single_value("MGK Settings", "company")
		for doctype in (
			"MGK Purchase Order",
			"MGK Delivery Challan",
			"MGK Goods Received Note",
			"MGK Purchase Invoice",
			"MGK Delivery Challan Close",
			"MGK Supplier Credit Debit",
		):
			self.assertEqual(hooks.doc_events[doctype]["before_validate"], "mgk_yrp.company.set_company")
			self.assertTrue(frappe.get_meta(doctype).has_field("company"), doctype)
			doc = frappe.new_doc(doctype)
			set_company(doc)
			self.assertEqual(doc.company, company)

	def test_existing_company_is_kept(self):
		doc = frappe.new_doc("MGK Purchase Order")
		doc.company = "Other"
		set_company(doc)
		self.assertEqual(doc.company, "Other")
