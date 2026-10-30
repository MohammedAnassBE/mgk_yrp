import json
from copy import deepcopy

import frappe
from frappe.client import save
from frappe.model.mapper import make_mapped_doc
from frappe.tests import IntegrationTestCase
from yrp.stock.dimensions import get_dimension_fieldnames

from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import make_goods_received_note
from mgk_yrp.stock.item_editor import get_item_details
from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.tests.fixtures import (
	make_item,
	make_purchase_order,
	make_received_type,
	make_supplier,
	make_uom,
	make_warehouse,
)

MAPPER = "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.make_goods_received_note"
ROW_FIELDS = ("item", "qty", "rate", "amount", "uom", "stock_uom", "conversion_factor", "received_type")


class TestWebPurchaseReceipt(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.supplier = make_supplier()
		self.warehouse = make_warehouse(supplier=make_supplier(is_company_location=1))
		self.item = make_item(stock_uom=make_uom("Kg"))

	def make_order(self, submit=True):
		return make_purchase_order(
			supplier=self.supplier,
			warehouse=self.warehouse,
			items=[{"item": self.item, "qty": 10, "rate": 5}],
			submit=submit,
		)

	def save_editor(self, doc):
		payload = doc.as_dict()
		payload["item_details"] = json.dumps(get_item_details(doc))
		payload["items"] = []
		result = save(payload)
		return frappe.get_doc(doc.doctype, result["name"])

	def row_values(self, doc):
		return [tuple(row.get(field) for field in ROW_FIELDS) for row in doc.items]

	def stock_values(self, doc):
		values = []
		for entry in get_voucher_sles(doc.doctype, doc.name):
			values.append(
				(
					frappe.db.get_value("YRP Stock Ledger Entry", entry.name, "received_type"),
					entry.qty,
					entry.rate,
					entry.stock_value_difference,
				)
			)
		return sorted(values)

	def test_po_editor_save_matches_desk_rows_and_keeps_names_on_resave(self):
		desk = self.make_order(submit=False)
		web = frappe.copy_doc(desk)
		web = self.save_editor(web)
		self.assertEqual(self.row_values(web), self.row_values(desk))
		names = [row.name for row in web.items]
		web = self.save_editor(web)
		self.assertEqual([row.name for row in web.items], names)
		self.assertEqual(self.row_values(web), self.row_values(desk))

	def test_mapper_keeps_pending_type_source_and_unsaved_editor_data(self):
		order = self.make_order()
		receipt = make_mapped_doc(MAPPER, order.name)
		self.assertTrue(receipt.is_new())
		self.assertEqual(receipt.purchase_order, order.name)
		self.assertEqual(receipt.supplier, order.supplier)
		self.assertEqual(receipt.warehouse, order.warehouse)
		self.assertEqual(receipt.items[0].purchase_order_item, order.items[0].name)
		self.assertEqual(receipt.items[0].qty, order.items[0].pending_qty)
		self.assertEqual(receipt.items[0].get("received_type"), order.items[0].get("received_type"))
		groups = receipt.get_onload()["item_details"]
		cells = [cell for group in groups for entry in group["items"] for cell in entry["values"].values() if cell]
		self.assertEqual(cells[0]["purchase_order_item"], order.items[0].name)
		self.assertEqual(cells[0]["pending_qty"], 10)

	def test_split_editor_payload_matches_desk_rows_sles_and_po_progress(self):
		if "received_type" not in get_dimension_fieldnames():
			self.skipTest("Received Type dimension is not configured")
		accepted, rejected = (make_received_type(value) for value in ("Accepted", "Rejected"))
		results = []
		for use_editor in (False, True):
			order = self.make_order()
			receipt = make_goods_received_note(order.name)
			receipt.items[0].qty = 6
			receipt.items[0].received_type = accepted
			second = deepcopy(receipt.items[0].as_dict())
			second.pop("name", None)
			second.update(qty=4, received_type=rejected)
			receipt.append("items", second)
			receipt = self.save_editor(receipt) if use_editor else receipt.insert(ignore_permissions=True)
			self.assertEqual([row.purchase_order_item for row in receipt.items], [order.items[0].name] * 2)
			receipt.submit()
			order.reload()
			results.append((sorted(self.row_values(receipt)), self.stock_values(receipt), order.status))
			self.assertEqual((order.items[0].received_qty, order.items[0].pending_qty), (10, 0))
			self.assertEqual(len(get_voucher_sles(receipt.doctype, receipt.name)), 2)
			receipt.cancel()
			self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))
			order.reload()
			self.assertEqual((order.items[0].received_qty, order.items[0].pending_qty), (0, 10))
		self.assertEqual(results[0], results[1])
