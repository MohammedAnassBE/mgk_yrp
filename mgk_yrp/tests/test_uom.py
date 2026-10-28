from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import frappe
from frappe.model.base_document import BaseDocument

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import MGKDeliveryChallan
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice import MGKPurchaseInvoice
from mgk_yrp.stock.uom import SNAPSHOT_FIELDS, has_uom_snapshot


class TestUOMSnapshots(TestCase):
	def setUp(self):
		self.enterContext(patch.object(BaseDocument, "_table_fieldnames", {}))
		self.enterContext(patch("frappe.translate.get_all_translations", return_value={}))
		self.source = BaseDocument(
			{
				"doctype": "MGK Purchase Order Item",
				"name": "source",
				"item": "item",
				"qty": 2,
				"stock_qty": 100,
				"rate": 5000,
				"uom": "Bag",
				"stock_uom": "Kg",
				"conversion_factor": 50,
			}
		)
		self.controllers = (
			(MGKGoodsReceivedNote.set_purchase_order_rows, "purchase_order_item"),
			(MGKDeliveryChallan.set_return_rows, "against_dc_item"),
			(MGKPurchaseInvoice.set_source_row, "goods_received_note_item"),
		)

	def apply_source(self, method, row):
		if method == MGKPurchaseInvoice.set_source_row:
			method(None, row, self.source)
		else:
			method(SimpleNamespace(items=[row]), SimpleNamespace(items=[self.source]))

	def make_row(self, source_field, *, is_new=True):
		return BaseDocument({**self.source.__dict__, source_field: "source", "__islocal": is_new, "idx": 1})

	def test_new_linked_rows_fill_partial_snapshot_despite_default_stock_uom(self):
		for method, source_field in self.controllers:
			for missing in (
				SNAPSHOT_FIELDS,
				("uom", "conversion_factor"),
				("stock_uom",),
				("conversion_factor",),
			):
				with self.subTest(controller=method.__qualname__, missing=missing):
					row = self.make_row(source_field)
					for field in missing:
						row.set(field, None)
					if "stock_uom" not in missing:
						row.stock_uom = "Nos"
					self.assertFalse(has_uom_snapshot(row))
					self.apply_source(method, row)
					self.assertTrue(has_uom_snapshot(row))
					self.assertEqual([row.get(field) for field in SNAPSHOT_FIELDS], ["Bag", "Kg", 50])

	def test_complete_mismatches_and_existing_partial_snapshots_are_rejected(self):
		for method, source_field in self.controllers:
			for is_new, value in ((True, "Nos"), (False, None)):
				with self.subTest(controller=method.__qualname__, is_new=is_new):
					row = self.make_row(source_field, is_new=is_new)
					row.uom = value
					with (
						patch("mgk_yrp.stock.uom.frappe.throw", side_effect=frappe.ValidationError),
						self.assertRaises(frappe.ValidationError),
					):
						self.apply_source(method, row)
