from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import flt

from mgk_yrp.tests.fixtures import make_supplier
from mgk_yrp.web.payment_ledger import get_payment_ledger

DOCTYPE = "MGK Supplier Credit Debit"


class TestWebPaymentLedger(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.supplier = make_supplier()
		for posting_date, entry_type, amount in (
			("2026-01-05", "Credit", 1000), ("2026-02-10", "Debit", 300),
			("2026-02-20", "Credit", 200), ("2026-03-01", "Debit", 150),
		):
			frappe.get_doc({
				"doctype": DOCTYPE, "supplier": self.supplier, "posting_date": posting_date,
				"entry_type": entry_type, "amount": amount, "reason": "Test",
			}).insert()

	def test_running_balance_in_date_order(self):
		ledger = get_payment_ledger(supplier=self.supplier)
		self.assertEqual(ledger["opening_balance"], 0)
		self.assertEqual([row["balance"] for row in ledger["rows"]], [1000, 700, 900, 750])
		self.assertEqual([(row["credit"], row["debit"]) for row in ledger["rows"]], [(1000, 0), (0, 300), (200, 0), (0, 150)])

	def test_opening_balance_before_from_date(self):
		ledger = get_payment_ledger(supplier=self.supplier, from_date="2026-02-15", to_date="2026-02-28")
		self.assertEqual(ledger["opening_balance"], 700)
		self.assertEqual([row["balance"] for row in ledger["rows"]], [900])
		self.assertEqual(ledger["totals"], {"credit": 200, "debit": 0, "balance": 900})

	def test_supplier_totals(self):
		ledger = get_payment_ledger(supplier=self.supplier)
		[row] = ledger["suppliers"]
		self.assertEqual((row["supplier"], row["credit"], row["debit"], row["balance"]), (self.supplier, 1200, 450, 750))
		self.assertEqual(ledger["totals"], {"credit": 1200, "debit": 450, "balance": 750})

	def make_bill(self, posting_date, grand_total, docstatus=1, bill_no=None):
		bill = frappe.get_doc({
			"doctype": "MGK Purchase Invoice", "against": "Purchase Order", "supplier": self.supplier,
			"posting_date": posting_date, "grand_total": grand_total, "bill_no": bill_no, "docstatus": docstatus,
		})
		bill.db_insert()
		return bill.name

	def test_submitted_bills_are_credit_rows_and_cancelled_bills_are_excluded(self):
		bill = self.make_bill("2026-02-15", 500, bill_no="INV-123")
		self.make_bill("2026-02-16", 999, docstatus=2)
		ledger = get_payment_ledger(supplier=self.supplier)
		self.assertEqual([row["balance"] for row in ledger["rows"]], [1000, 700, 1200, 1400, 1250])
		bill_row = ledger["rows"][2]
		self.assertEqual((bill_row["name"], bill_row["type"], bill_row["reason"], bill_row["credit"]), (bill, "Bill", "Bill · INV-123", 500))
		self.assertEqual(ledger["totals"], {"credit": 1700, "debit": 450, "balance": 1250})
		opening = get_payment_ledger(supplier=self.supplier, from_date="2026-02-20")
		self.assertEqual(opening["opening_balance"], 1200)

	def test_bills_hidden_without_bill_read_permission(self):
		self.make_bill("2026-02-15", 500)
		with patch("mgk_yrp.web.payment_ledger.frappe.has_permission", side_effect=lambda doctype, *args, **kwargs: doctype != "MGK Purchase Invoice"):
			ledger = get_payment_ledger(supplier=self.supplier)
		self.assertEqual([row["balance"] for row in ledger["rows"]], [1000, 700, 900, 750])

	def test_all_suppliers_rows_use_supplier_running_balance(self):
		other = make_supplier()
		for posting_date, entry_type, amount in (("2026-01-01", "Credit", 50), ("2026-02-12", "Debit", 20)):
			frappe.get_doc({
				"doctype": DOCTYPE, "supplier": other, "posting_date": posting_date,
				"entry_type": entry_type, "amount": amount, "reason": "Other",
			}).insert()
		ledger = get_payment_ledger(from_date="2026-01-02")
		rows = [(row["supplier"], row["balance"]) for row in ledger["rows"] if row["supplier"] in (self.supplier, other)]
		self.assertEqual(rows, [(self.supplier, 1000), (self.supplier, 700), (other, 30), (self.supplier, 900), (self.supplier, 750)])
		self.assertTrue(all(row["supplier_name"] for row in ledger["rows"]))
		self.assertEqual(ledger["totals"]["balance"], flt(ledger["opening_balance"] + ledger["totals"]["credit"] - ledger["totals"]["debit"]))

	def test_from_date_after_to_date_is_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			get_payment_ledger(from_date="2026-03-01", to_date="2026-02-01")
