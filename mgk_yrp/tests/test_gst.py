from unittest.mock import patch

import frappe

from mgk_yrp.purchase.gst import apply_row_gst, get_gst_context
from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import (
	make_item,
	make_job_work_grn,
	make_purchase_invoice,
	make_supplier,
	make_tax_slab,
	make_uom,
	run_adjustments,
	set_mgk_settings,
)

REVALUATION = "mgk_yrp.purchase.revaluation"


class TestGST(CloseTestCase):
	def setUp(self):
		super().setUp()
		set_mgk_settings()
		self.slab = make_tax_slab("5")
		self.tax_item = make_item(stock_uom=make_uom("Kg"), tax_slab=self.slab)
		self.local_supplier = make_supplier(tax_id="33BBBBB0000B1Z5")
		self.remote_supplier = make_supplier(tax_id="29CCCCC0000C1Z5")

	def make_tax_invoice(self, supplier=None, *, items=None, rate=1234.57, submit=False):
		receipt = make_job_work_grn(
			supplier=supplier or self.local_supplier,
			warehouse=self.main,
			items=items or [{"item": self.tax_item, "qty": 1, "rate": rate}],
		)
		invoice = make_purchase_invoice(
			against="Job Work",
			supplier=receipt.supplier,
			grns=[receipt],
			submit=submit,
		)
		return invoice, receipt

	def test_no_gstin_supplier_no_tax(self):
		invoice, _ = self.make_tax_invoice(
			self.supplier, items=[{"item": self.output_item, "qty": 1, "rate": 100}]
		)
		self.assertEqual(invoice.tax_type, "No Tax")
		self.assertEqual(
			(invoice.total_cgst, invoice.total_sgst, invoice.total_igst, invoice.total_tax), (0, 0, 0, 0)
		)
		self.assertEqual(invoice.grand_total, invoice.net_total)
		self.assertFalse(invoice.items[0].gst_tax_slab)
		self.assertEqual(invoice.items[0].gst_rate, 0)
		with patch("mgk_yrp.purchase.gst.frappe.get_single") as settings:
			settings.return_value.company_gstin = ""
			self.assertEqual(get_gst_context(self.supplier).tax_type, "No Tax")

	def test_no_gstin_supplier_still_snapshots_slab(self):
		invoice, _ = self.make_tax_invoice(self.supplier)
		self.assertEqual((invoice.items[0].gst_tax_slab, invoice.items[0].gst_rate), (self.slab, 5))
		self.assertEqual(invoice.total_tax, 0)

	def test_same_state_splits_cgst_sgst(self):
		invoice, _ = self.make_tax_invoice()
		self.assertEqual(invoice.tax_type, "CGST + SGST")
		self.assertEqual((invoice.total_cgst, invoice.total_sgst, invoice.total_igst), (30.86, 30.86, 0))
		self.assertEqual(
			(invoice.net_total, invoice.total_tax, invoice.grand_total), (1234.57, 61.72, 1296.29)
		)

	def test_other_state_igst(self):
		invoice, _ = self.make_tax_invoice(self.remote_supplier)
		self.assertEqual(invoice.tax_type, "IGST")
		self.assertEqual((invoice.total_cgst, invoice.total_sgst, invoice.total_igst), (0, 0, 61.73))
		self.assertEqual(invoice.grand_total, 1296.30)

	def test_tax_rounds_per_row_before_totalling(self):
		invoice, _ = self.make_tax_invoice(
			items=[{"item": self.tax_item, "qty": 1, "rate": 1.01} for _ in range(2)]
		)
		self.assertEqual([row.cgst_amount for row in invoice.items], [0.03, 0.03])
		self.assertEqual((invoice.total_cgst, invoice.total_sgst), (0.06, 0.06))

	def test_slab_disabled_or_out_of_range_rejected(self):
		for percentage, enabled in (("105", 1), ("-1", 1), ("abc", 1), ("nan", 1), ("inf", 1), ("5", 0)):
			with self.subTest(percentage=percentage, enabled=enabled):
				frappe.db.set_value("YRP Tax Slab", self.slab, {"percentage": percentage, "enabled": enabled})
				try:
					with self.assertRaisesRegex(frappe.ValidationError, "GST slab"):
						apply_row_gst(frappe._dict(item=self.tax_item, amount=100), "IGST")
				finally:
					frappe.db.set_value("YRP Tax Slab", self.slab, {"percentage": "5", "enabled": 1})

	def test_zero_and_hundred_percent_slabs_allowed(self):
		for percentage in ("0", "100"):
			item = make_item(stock_uom=make_uom("Kg"), tax_slab=make_tax_slab(percentage))
			row = frappe._dict(item=item, amount=100)
			apply_row_gst(row, "IGST")
			self.assertEqual(row.igst_amount, float(percentage))

	def test_missing_item_slab_with_gstin_rejected(self):
		with self.assertRaisesRegex(frappe.ValidationError, "MGK GST Tax Slab.*supplier has a GSTIN"):
			self.make_tax_invoice(items=[{"item": self.output_item, "qty": 1, "rate": 100}])

	def test_missing_company_gstin_rejected(self):
		with patch("mgk_yrp.purchase.gst.frappe.get_single") as settings:
			settings.return_value.company_gstin = ""
			with self.assertRaisesRegex(frappe.ValidationError, "Company GSTIN is required"):
				get_gst_context(self.local_supplier)

	def test_gst_snapshot_survives_master_change(self):
		invoice, _ = self.make_tax_invoice(submit=True)
		original = self.snapshot(invoice)
		frappe.db.set_value("Item", self.tax_item, "mgk_gst_tax_slab", make_tax_slab("12"))
		frappe.db.set_value("Supplier", self.local_supplier, "tax_id", "29DDDDD0000D1Z5")
		set_mgk_settings("29EEEEE0000E1Z5")
		frappe.db.set_value("YRP Tax Slab", self.slab, "enabled", 0)
		try:
			invoice = frappe.get_doc(invoice.doctype, invoice.name)
			invoice.validate()
			self.assertEqual(self.snapshot(invoice), original)
			self.assertEqual(self.snapshot(invoice.reload()), original)
		finally:
			frappe.db.set_value("YRP Tax Slab", self.slab, "enabled", 1)

	def snapshot(self, invoice):
		return (
			invoice.supplier_gstin,
			invoice.company_gstin,
			invoice.tax_type,
			invoice.items[0].gst_tax_slab,
			invoice.items[0].gst_rate,
			invoice.total_cgst,
			invoice.total_sgst,
			invoice.total_igst,
		)

	def test_draft_gst_refreshes_on_submit(self):
		invoice, _ = self.make_tax_invoice()
		frappe.db.set_value("Item", self.tax_item, "mgk_gst_tax_slab", make_tax_slab("12"))
		invoice.submit()
		self.assertEqual(invoice.items[0].gst_rate, 12)
		self.assertEqual(invoice.total_cgst, 74.07)

	def test_gst_not_in_stock_value(self):
		receipt = make_job_work_grn(
			supplier=self.local_supplier,
			warehouse=self.main,
			items=[{"item": self.tax_item, "qty": 100, "rate": 100}],
		)
		with patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=True):
			invoice = make_purchase_invoice(
				against="Job Work",
				supplier=self.local_supplier,
				grns=[receipt],
				rates={receipt.items[0].name: 110},
			)
		self.assertEqual((invoice.net_total, invoice.total_tax, invoice.grand_total), (11000, 550, 11550))
		adjustments = run_adjustments(invoice.doctype, invoice.name)
		adjustment = frappe.get_doc("YRP Stock Valuation Adjustment", adjustments[0])
		self.assertEqual(adjustment.total_source_difference, 1000)
		self.assertEqual(self.get_overlay(receipt), 1000)

	def test_row_tax_override_ignored(self):
		invoice, _ = self.make_tax_invoice()
		invoice.items[0].update(
			{
				"gst_tax_slab": make_tax_slab("12"),
				"gst_rate": 100,
				"cgst_amount": 999,
				"sgst_amount": 999,
				"igst_amount": 999,
			}
		)
		invoice.supplier_gstin = ""
		invoice.company_gstin = ""
		invoice.tax_type = "No Tax"
		invoice.save()
		self.assertEqual((invoice.items[0].gst_tax_slab, invoice.items[0].gst_rate), (self.slab, 5))
		self.assertEqual((invoice.total_cgst, invoice.total_sgst, invoice.total_igst), (30.86, 30.86, 0))
		self.assertEqual(invoice.supplier_gstin, "33BBBBB0000B1Z5")
		self.assertEqual(invoice.company_gstin, "33AAAAA0000A1Z5")

	def test_variant_uses_parent_item_slab(self):
		variant = make_item(
			stock_uom=make_uom("Kg"), purchase_uom=make_uom("Bag"), conversion_factor=50, tax_slab=self.slab
		)
		row = frappe._dict(item=variant, amount=100)
		apply_row_gst(row, "IGST")
		self.assertEqual((row.gst_tax_slab, row.gst_rate, row.igst_amount), (self.slab, 5, 5))
