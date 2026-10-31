import frappe
from frappe.tests import IntegrationTestCase

from mgk_yrp.tests.fixtures import make_supplier
from mgk_yrp.web.preview import get_preview

DOCTYPE = "MGK Supplier Credit Debit"


class TestSupplierCreditDebit(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.supplier = make_supplier()

	def make_entry(self, **values):
		return frappe.get_doc(
			{
				"doctype": DOCTYPE,
				"supplier": self.supplier,
				"entry_type": "Credit",
				"amount": 100,
				"reason": "Rate difference",
				**values,
			}
		)

	def test_saves_credit_and_debit_with_default_date(self):
		for entry_type in ("Credit", "Debit"):
			doc = self.make_entry(entry_type=entry_type).insert()
			self.assertTrue(doc.name.startswith("MGK-SCD-"))
			self.assertEqual(str(doc.posting_date), frappe.utils.today())

	def test_amount_must_be_positive(self):
		for amount in (0, -5):
			with self.assertRaisesRegex(frappe.ValidationError, "greater than zero"):
				self.make_entry(amount=amount).insert()

	def test_required_fields_are_enforced(self):
		for field in ("supplier", "entry_type", "reason"):
			with self.assertRaises(frappe.MandatoryError):
				self.make_entry(**{field: None}).insert()

	def test_preview_returns_doc_and_timeline(self):
		doc = self.make_entry().insert()
		preview = get_preview(DOCTYPE, doc.name)
		self.assertEqual(preview["doc"]["amount"], 100)
		self.assertEqual(preview["items"], [])
		self.assertTrue(preview["timeline"])
