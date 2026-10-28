from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import frappe
from frappe.model.base_document import BaseDocument

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import MGKDeliveryChallan
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice import (
	MGKPurchaseInvoice,
	get_grn_rows,
)
from mgk_yrp.stock.uom import (
	SNAPSHOT_FIELDS,
	apply_independent_uom,
	copy_uom_snapshot,
	has_uom_snapshot,
	validate_uom_snapshot,
)

INVOICE = "mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice"


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

	def test_copy_snapshot_supports_documents_and_dict_rows(self):
		for row_type in (BaseDocument, dict, frappe._dict):
			with self.subTest(row_type=row_type.__name__):
				row = row_type({"qty": 3, "stock_qty": -1, "idx": 1})
				copy_uom_snapshot(row, self.source.__dict__)
				self.assertEqual([row.get(field) for field in SNAPSHOT_FIELDS], ["Bag", "Kg", 50])
				self.assertEqual(row.get("qty"), 3)
				self.assertEqual(row.get("stock_qty"), 150)
				self.assertTrue(has_uom_snapshot(row))
				validate_uom_snapshot(row, self.source, "Source")

	def test_validate_snapshot_rejects_dict_mismatches(self):
		for field in SNAPSHOT_FIELDS:
			with self.subTest(field=field):
				row = {**self.source.__dict__, "idx": 4, field: None}
				with (
					patch("frappe.throw", side_effect=frappe.ValidationError) as throw,
					self.assertRaises(frappe.ValidationError),
				):
					validate_uom_snapshot(row, self.source, "Source")
				self.assertIn(f"row 4 has a different {field}", throw.call_args.args[0])

	def test_independent_uom_resolves_dict_rows_from_item_master(self):
		for row_type in (dict, frappe._dict):
			with self.subTest(row_type=row_type.__name__):
				row = row_type(item="item", qty=3, uom="Nos", conversion_factor=1)
				with patch("mgk_yrp.stock.uom.resolve_item_uom", return_value=self.source) as resolve:
					apply_independent_uom(row)
				resolve.assert_called_once_with("item")
				self.assertEqual([row.get(field) for field in SNAPSHOT_FIELDS], ["Bag", "Kg", 50])
				self.assertEqual(row["stock_qty"], 150)

	def test_get_grn_rows_copies_snapshot_into_invoice_rows(self):
		with patch(f"{INVOICE}.get_billable_grn", return_value=SimpleNamespace(items=[self.source])):
			rows = get_grn_rows(["receipt"])
		self.assertEqual(len(rows), 1)
		row = rows[0]
		self.assertIsInstance(row, frappe._dict)
		self.assertEqual([row.get(field) for field in SNAPSHOT_FIELDS], ["Bag", "Kg", 50])
		self.assertEqual((row.goods_received_note, row.goods_received_note_item), ("receipt", "source"))
		self.assertEqual((row.qty, row.stock_qty, row.rate, row.grn_rate), (2, 100, 5000, 5000))
		MGKPurchaseInvoice.set_source_row(None, BaseDocument(row), self.source)

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
