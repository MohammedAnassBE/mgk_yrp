from collections import defaultdict
from unittest import TestCase
from unittest.mock import Mock, patch

import frappe

from mgk_yrp.job_work.close_valuation import build_consumption_entries
from mgk_yrp.job_work.reopen import complete_reopen
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import (
	MGKDeliveryChallan,
	make_return_delivery_challan,
)
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import (
	MGKPurchaseOrder,
	set_receipt_header,
	set_receipt_row,
)
from mgk_yrp.stock.dimensions import get_dimension_defaults, prepare_row_dimensions
from mgk_yrp.stock.ledger import receipt_entry, transfer_entries, validate_stock_dimensions
from mgk_yrp.tests.test_item_editor import EditorDocument, make_document, make_row, validation_error

DIMENSIONS = "mgk_yrp.stock.dimensions"
LEDGER = "mgk_yrp.stock.ledger"
ORDER = MGKPurchaseOrder.__module__
CHALLAN = MGKDeliveryChallan.__module__
RECEIPT = MGKGoodsReceivedNote.__module__
RECEIVED_TYPE = {
	"fieldname": "received_type",
	"label": "Received Type",
	"dimension_doctype": "YRP Received Type",
	"mandatory": 1,
	"in_valuation": 0,
	"is_production_group": 0,
}


class MappingDocument(EditorDocument):
	def update(self, values):
		self.__dict__.update(values)

	def append(self, field, values):
		row = make_row(**values)
		getattr(self, field).append(row)
		return row

	def set_onload(self, key, value):
		self.__dict__.setdefault("__onload", {})[key] = value

	def set_row_values(self):
		MGKDeliveryChallan.set_row_values(self)


class TestReceivedType(TestCase):
	def setUp(self):
		self.database = Mock()
		self.database.get_single_value.return_value = "Accepted"
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", side_effect=validation_error))
		self.enterContext(patch("frappe._", side_effect=lambda text: text))
		self.enterContext(patch("frappe.get_system_settings", return_value=None))
		for module in (LEDGER, CHALLAN, RECEIPT):
			self.enterContext(patch(f"{module}._", side_effect=lambda text: text))
		for module in (DIMENSIONS, "yrp.stock.dimensions", LEDGER):
			self.enterContext(patch(f"{module}.get_stock_dimensions", return_value=[RECEIVED_TYPE]))
		self.enterContext(patch(f"{LEDGER}.get_dimension_fieldnames", return_value=["received_type"]))

	def test_before_validate_defaults_rows_in_each_controller(self):
		for controller, doctype in (
			(MGKPurchaseOrder, "MGK Purchase Order"),
			(MGKDeliveryChallan, "MGK Delivery Challan"),
			(MGKGoodsReceivedNote, "MGK Goods Received Note"),
		):
			with (
				self.subTest(controller=controller.__name__),
				patch(f"{controller.__module__}.set_items_from_editor"),
				patch(f"{controller.__module__}.apply_posting_datetime", create=True),
			):
				doc = make_document(doctype, items=[make_row(), make_row(received_type="Rejected")])
				controller.before_validate(doc)
				self.assertEqual([row.received_type for row in doc.items], ["Accepted", "Rejected"])
				self.assertIsNone(doc.get("received_type"))

	def test_mandatory_blank_throws_but_po_is_optional(self):
		self.database.get_single_value.return_value = None
		for doctype in ("MGK Goods Received Note", "MGK Delivery Challan"):
			with (
				self.subTest(doctype=doctype),
				self.assertRaisesRegex(frappe.ValidationError, "Received Type is required"),
			):
				prepare_row_dimensions(make_document(doctype))
		prepare_row_dimensions(make_document())
		self.assertEqual(get_dimension_defaults(), {})

	def test_no_dimensions_needs_no_defaults_or_keys(self):
		with (
			patch("yrp.stock.dimensions.get_stock_dimensions", return_value=[]),
			patch(f"{DIMENSIONS}.get_stock_dimensions", return_value=[]),
		):
			self.assertEqual(get_dimension_defaults(), {})
			prepare_row_dimensions(make_document("MGK Goods Received Note"))
		self.database.get_single_value.assert_not_called()

	def test_po_to_grn_copies_each_row_dimension_and_defaults_blank(self):
		for value, expected in (("Rejected", "Rejected"), (None, "Accepted")):
			with self.subTest(value=value):
				source = make_row(received_type=value)
				target = make_row()
				set_receipt_row(source, target, None)
				self.assertEqual(target.received_type, expected)
		parent = frappe._dict(supplier="Supplier", receipt_location={"location": "Location", "warehouse": "Warehouse"})
		target_doc = MappingDocument(items=[target], item_details=None)
		with patch(f"{ORDER}.apply_posting_datetime"), patch(f"{ORDER}.get_item_details", return_value=[]):
			set_receipt_header(parent, target_doc)
		self.assertIsNone(target_doc.get("received_type"))

	def test_return_mapping_copies_row_dimensions(self):
		source = MappingDocument(
			name="DC-1",
			doctype="MGK Delivery Challan",
			docstatus=1,
			is_return=0,
			from_location="Owner",
			to_location="Supplier",
			from_warehouse="Main",
			to_warehouse="Job",
			process_name="Dyeing",
			items=[make_row(name="dc-row", stock_qty=100, received_type="Rejected")],
			check_permission=Mock(),
			validate_open=Mock(),
			get_returned_stock_qty=lambda: {"dc-row": 0},
		)
		target = MappingDocument(items=[], item_details=None)
		with (
			patch("frappe.has_permission"),
			patch(f"{CHALLAN}.lock_documents"),
			patch("frappe.get_doc", return_value=source),
			patch("frappe.new_doc", return_value=target),
			patch(f"{CHALLAN}.apply_posting_datetime"),
			patch(f"{CHALLAN}.get_item_details", return_value=[]),
		):
			make_return_delivery_challan(source.name)
		self.assertEqual(target.items[0].received_type, "Rejected")
		self.assertEqual(target.items[0].against_dc_item, "dc-row")

	def test_return_row_dimension_mismatch_throws(self):
		source = make_document(items=[make_row(name="source", received_type="Accepted")])
		doc = make_document(items=[make_row(name=None, against_dc_item="source", received_type="Rejected")])
		with self.assertRaisesRegex(frappe.ValidationError, "Received Type must match"):
			MGKDeliveryChallan.set_return_rows(doc, source)
		doc.items[0].received_type = "Accepted"
		MGKDeliveryChallan.set_return_rows(doc, source)

	def test_receipt_and_transfer_use_each_row_only_when_configured(self):
		doc = frappe._dict(
			doctype="MGK Goods Received Note",
			name="GRN",
			received_type="Wrong",
			posting_date="2026-10-29",
			posting_time="10:00:00",
		)
		for configured in ([], ["received_type"]):
			with patch(f"{LEDGER}.get_dimension_fieldnames", return_value=configured):
				for value in ("Accepted", "Rejected"):
					row = make_row(name=value, stock_qty=100, stock_rate=2, received_type=value)
					entries = [receipt_entry(doc, row, "Main")]
					entries += transfer_entries(doc, row, from_warehouse="Main", to_warehouse="Job")
					self.assertEqual(
						[entry.get("received_type") for entry in entries], [value if configured else None] * 3
					)
					if not configured:
						self.assertTrue(all("received_type" not in entry for entry in entries))

	def test_close_consumption_uses_dc_source_rows_including_reopen(self):
		sources = [make_row(name=value, received_type=value) for value in ("Accepted", "Rejected")]
		rows = [
			make_row(name=f"close-{row.name}", delivery_challan_item=row.name, remaining_stock_qty=5)
			for row in sources
		]
		close = make_document(
			"MGK Delivery Challan Close",
			name="Close",
			delivery_challan="DC-1",
			warehouse="Job",
			posting_date="2026-10-29",
			posting_time="11:00:00",
			items=rows,
			db_set=Mock(),
			notify_update=Mock(),
		)
		challan = make_document(
			items=sources, close_status="Reopening", delivery_challan_close="Close", reload=Mock(), notify_update=Mock()
		)
		reopen = "mgk_yrp.job_work.reopen"
		with (
			patch("frappe.get_doc", return_value=challan),
			patch(f"{reopen}.validate_reopen_backdating"),
			patch(f"{reopen}.deactivate_production_links"),
			patch(f"{reopen}.enqueue_voucher_repost"),
			patch(f"{reopen}.post_stock_entries") as post,
		):
			entries = build_consumption_entries(close, rows)
			self.assertEqual([entry["received_type"] for entry in entries], ["Accepted", "Rejected"])
			complete_reopen(close)
			post.assert_called_once_with(entries, cancel=True)
			close.notify_update.assert_called_once_with()

	def test_quantity_dimensions_allowed_valuation_and_production_rejected(self):
		validate_stock_dimensions()
		for flag in ("in_valuation", "is_production_group"):
			with patch(f"{LEDGER}.get_stock_dimensions", return_value=[{**RECEIVED_TYPE, flag: 1}]):
				with self.assertRaisesRegex(frappe.ValidationError, "Stock dimension received_type"):
					validate_stock_dimensions()

	def test_split_po_row_receipt_links_and_cap_sums_both_types(self):
		source = make_row(name="po-source", qty=10)
		order = make_document(items=[source])
		rows = [
			make_row(name=None, purchase_order_item=None, qty=qty, received_type=value)
			for qty, value in ((6, "Accepted"), (4, "Rejected"))
		]
		doc = make_document("MGK Goods Received Note", items=rows)
		MGKGoodsReceivedNote.set_purchase_order_rows(doc, order)
		self.assertEqual([row.purchase_order_item for row in rows], ["po-source"] * 2)
		doc.get_other_received_quantities = lambda: defaultdict(float)
		with patch(f"{RECEIPT}._po_excess_percentage", return_value=0):
			MGKGoodsReceivedNote.validate_receipt_allowance(doc, order)
			rows[1].qty = 5
			with self.assertRaisesRegex(frappe.ValidationError, "exceeds the allowed quantity"):
				MGKGoodsReceivedNote.validate_receipt_allowance(doc, order)

	def test_new_po_cell_rejects_ambiguous_and_missing_variant(self):
		for sources in ([], [make_row(name="one"), make_row(name="two")]):
			doc = make_document(items=[make_row(name=None, purchase_order_item=None)])
			with self.assertRaisesRegex(frappe.ValidationError, "Expected exactly one Purchase Order row"):
				MGKGoodsReceivedNote.set_purchase_order_rows(doc, make_document(items=sources))
