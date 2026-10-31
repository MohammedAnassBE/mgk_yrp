import json
from unittest.mock import patch

import frappe
from frappe.utils import add_days, today

from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import (
	make_job_work_grn,
	make_po_grn,
	make_purchase_invoice,
	make_purchase_order,
	make_supplier,
)
from mgk_yrp.web.pending_bills import create_bills, get_bill_drafts, get_pending_bills

GRN = "MGK Goods Received Note"
INVOICE = "MGK Purchase Invoice"
REVALUATION = "mgk_yrp.purchase.revaluation"


class TestWebPendingBills(CloseTestCase):
	def setUp(self):
		super().setUp()
		setting = patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=True)
		setting.start()
		self.addCleanup(setting.stop)

	def make_aged_grn(self, supplier, days, rate=10):
		receipt = make_job_work_grn(
			supplier=supplier, warehouse=self.main, items=[{"item": self.output_item, "qty": 2, "rate": rate}]
		)
		frappe.db.set_value(GRN, receipt.name, "posting_date", add_days(today(), -days))
		return receipt

	def pending_for(self, *suppliers):
		return [group for group in get_pending_bills()["suppliers"] if group["supplier"] in suppliers]

	def make_po_grn_for(self, supplier):
		order = make_purchase_order(
			supplier=supplier, warehouse=self.main, items=[{"item": self.raw_item, "qty": 5, "rate": 100}]
		)
		return make_po_grn(order)

	def test_suppliers_ordered_by_summed_aging_and_grns_oldest_first(self):
		first, second = make_supplier(), make_supplier()
		for days in (45, 5, 3):
			self.make_aged_grn(first, days)
		for days in (15, 40, 20):
			self.make_aged_grn(second, days)
		groups = self.pending_for(first, second)
		self.assertEqual([group["supplier"] for group in groups], [second, first])
		self.assertEqual([group["total_aging"] for group in groups], [75, 53])
		self.assertEqual([grn.aging for grn in groups[0]["grns"]], [40, 20, 15])
		self.assertEqual([grn.bucket for grn in groups[0]["grns"]], ["30+", "16-30", "8-15"])
		self.assertEqual([grn.bucket for grn in groups[1]["grns"]], ["30+", "0-7", "0-7"])
		self.assertEqual((groups[1]["grn_count"], groups[1]["total_amount"]), (3, 60))
		grn = groups[0]["grns"][0]
		self.assertEqual(grn.against, "Job Work")
		self.assertEqual([(row["item"], row["qty"], row["rate"], row["amount"]) for row in grn["items"]], [(self.output_item, 2, 10, 20)])

	def test_billed_grns_leave_and_unbilled_ones_stay(self):
		billed = self.make_aged_grn(self.supplier, 10)
		open_receipt = self.make_aged_grn(self.supplier, 4, rate=7)
		make_purchase_invoice(against="Job Work", supplier=self.supplier, grns=[billed], submit=False)
		[group] = self.pending_for(self.supplier)
		self.assertEqual([grn.name for grn in group["grns"]], [open_receipt.name])
		self.assertEqual(group["total_amount"], 14)
		count = get_pending_bills()["count"]
		self.assertEqual(count, frappe.db.count(GRN, {"docstatus": 1, "purchase_invoice": ["is", "not set"]}))

	def test_create_bills_across_two_suppliers_submits_each(self):
		job = self.make_output([])
		purchase = self.make_input()
		bills = [
			{"supplier": self.supplier, "bill_no": "JW-1", "bill_date": "2026-10-20", "grns": [job.name], "rates": {job.items[0].name: 12}},
			{"supplier": self.purchase_supplier, "bill_no": "PO-1", "bill_date": today(), "grns": [purchase.name]},
		]
		created = create_bills(json.dumps(bills))
		self.assertEqual([(row["supplier"], row["against"]) for row in created], [(self.supplier, "Job Work"), (self.purchase_supplier, "Purchase Order")])
		first = frappe.get_doc(INVOICE, created[0]["name"])
		self.assertEqual((first.docstatus, first.bill_no, str(first.bill_date), first.items[0].rate), (1, "JW-1", "2026-10-20", 12))
		self.assertEqual(first.net_total, 720)
		self.assertEqual(job.reload().purchase_invoice, first.name)
		self.assertEqual(purchase.reload().purchase_invoice, created[1]["name"])
		self.assertFalse(self.pending_for(self.supplier, self.purchase_supplier))

	def test_mixed_po_and_job_work_split_into_two_bills_with_same_invoice_no(self):
		purchase = self.make_po_grn_for(self.supplier)
		job = self.make_output([])
		drafts = get_bill_drafts([job.name, purchase.name])
		self.assertEqual(sorted(draft["against"] for draft in drafts), ["Job Work", "Purchase Order"])
		self.assertTrue(all(draft["tax_type"] for draft in drafts))
		created = create_bills([{"supplier": self.supplier, "bill_no": "MIX-9", "bill_date": today(), "grns": [job.name, purchase.name]}])
		invoices = [frappe.get_doc(INVOICE, row["name"]) for row in created]
		self.assertEqual(sorted(invoice.against for invoice in invoices), ["Job Work", "Purchase Order"])
		self.assertEqual({invoice.bill_no for invoice in invoices}, {"MIX-9"})
		self.assertEqual({invoice.docstatus for invoice in invoices}, {1})

	def test_missing_invoice_no_rolls_back_every_bill(self):
		job = self.make_output([])
		purchase = self.make_input()
		bills = [
			{"supplier": self.supplier, "bill_no": "OK-1", "bill_date": today(), "grns": [job.name]},
			{"supplier": self.purchase_supplier, "bill_no": " ", "bill_date": today(), "grns": [purchase.name]},
		]
		with self.assertRaisesRegex(frappe.ValidationError, "Supplier Invoice No is required"):
			create_bills(bills)
		self.assertEqual(frappe.local.message_log[-1]["title"], self.purchase_supplier)
		self.assertFalse(frappe.db.exists(INVOICE, {"supplier": self.supplier}))
		self.assertFalse(job.reload().purchase_invoice)
		self.assertEqual(len(self.pending_for(self.supplier, self.purchase_supplier)), 2)
