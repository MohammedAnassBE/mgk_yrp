from unittest.mock import patch

import frappe
from frappe.model.document import Document
from frappe.tests import IntegrationTestCase

from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import mark_as_received
from mgk_yrp.tests.fixtures import (
	make_item,
	make_po_grn,
	make_process,
	make_purchase_invoice,
	make_purchase_order,
	make_supplier,
	make_uom,
	make_warehouse,
)
from mgk_yrp.web.preview import CHALLAN, CLOSE, INVOICE, PLAN, get_extra, get_preview


class TestWebPreview(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.enterContext(patch("frappe.enqueue"))
		self.previous_user = frappe.session.user
		self.addCleanup(frappe.set_user, self.previous_user)
		frappe.set_user("Administrator")

	def make_order(self, **header):
		location = make_supplier(is_company_location=1)
		warehouse = header.pop("warehouse", None) or make_warehouse(supplier=location)
		return make_purchase_order(
			supplier=make_supplier(),
			warehouse=warehouse,
			items=[{"item": make_item(stock_uom=make_uom("Kg")), "qty": 10, "rate": 100}],
			**header,
		)

	def test_unknown_doctype_is_rejected_before_loading(self):
		with patch("frappe.get_doc") as load:
			with self.assertRaises(frappe.ValidationError):
				get_preview("User", "Administrator")
			load.assert_not_called()

	def test_user_without_read_is_denied(self):
		order = self.make_order()
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": f"preview-{frappe.generate_hash(length=8)}@example.com",
				"first_name": "Preview",
				"send_welcome_email": 0,
			}
		).insert()
		frappe.set_user(user.name)
		with self.assertRaises(frappe.PermissionError):
			get_preview(order.doctype, order.name)

	def test_purchase_order_lists_receipt_and_challan(self):
		frappe.db.set_value("Supplier", {"mgk_is_head_office": 1}, "mgk_is_head_office", 0)
		head_office = frappe.get_doc("Supplier", make_supplier(is_company_location=1))
		head_office.mgk_is_head_office = 1
		head_office.save()
		make_warehouse(supplier=head_office.name)
		worker = make_supplier()
		order = self.make_order(
			deliver_to_supplier=1,
			process_name=make_process(),
			delivery_location=worker,
			warehouse=make_warehouse(supplier=worker),
		)
		result = mark_as_received(order.name)
		preview = get_preview(order.doctype, order.name)
		connections = {row["doctype"]: row["names"] for row in preview["connections"]}
		self.assertIn(result["goods_received_note"], connections["MGK Goods Received Note"])
		self.assertIn(result["delivery_challan"], connections["MGK Delivery Challan"])
		self.assertEqual(len(preview["items"]), 1)
		self.assertEqual(preview["is_submittable"], 1)
		self.assertIs(type(preview["is_submittable"]), int)
		self.assertNotIn("__onload", preview["doc"])
		self.assertEqual(
			preview["timeline"], sorted(preview["timeline"], key=lambda row: row["at"], reverse=True)
		)

	def test_unreadable_connections_are_omitted(self):
		order = self.make_order()
		original = frappe.has_permission

		def has_permission(doctype, *args, **kwargs):
			return False if doctype == "MGK Delivery Challan" else original(doctype, *args, **kwargs)

		with (
			patch("frappe.has_permission", side_effect=has_permission),
			patch("frappe.get_list", wraps=frappe.get_list) as query,
		):
			get_preview(order.doctype, order.name)
		self.assertNotIn("MGK Delivery Challan", [call.args[0] for call in query.call_args_list])

	def test_field_permissions_filter_parent_children_and_derived_values(self):
		order = self.make_order()

		def filter_fields(doc):
			self.assertTrue(doc.get("__onload").get("item_details"))
			del doc.supplier
			del doc.items[0].item

		with (
			patch.object(
				Document, "apply_fieldlevel_read_permissions", autospec=True, side_effect=filter_fields
			) as apply,
			patch("mgk_yrp.web.preview.get_extra", side_effect=lambda doc: {"supplier": doc.get("supplier")}),
		):
			preview = get_preview(order.doctype, order.name)
		apply.assert_called_once()
		self.assertIsNone(preview["doc"].get("supplier"))
		self.assertIsNone(preview["items"][0].get("item"))
		self.assertEqual(preview["doc"]["items"], preview["items"])
		self.assertEqual(preview["extra"], {"supplier": None})
		self.assertNotIn("__onload", preview["doc"])
		self.assertNotIn("item_details", preview["doc"])

	def test_restricted_item_table_is_not_returned(self):
		order = self.make_order()
		with patch.object(
			Document,
			"apply_fieldlevel_read_permissions",
			autospec=True,
			side_effect=lambda doc: doc.__dict__.pop("items", None),
		):
			preview = get_preview(order.doctype, order.name)
		self.assertEqual(preview["items"], [])
		self.assertEqual(preview["doc"]["items"], [])
		self.assertNotIn("__onload", preview["doc"])

	def test_extra_plan_rows_are_permission_filtered(self):
		challan = frappe.get_doc({"doctype": CHALLAN, "mgk_process_planning": "Preview Plan"})
		plan = frappe.get_doc({"doctype": PLAN, "items": [{"item": "Restricted Item", "qty": 9}]})
		with (
			patch("frappe.has_permission", return_value=True),
			patch("frappe.get_doc", return_value=plan),
			patch.object(
				Document,
				"apply_fieldlevel_read_permissions",
				autospec=True,
				side_effect=lambda doc: doc.items[0].set("item", None),
			) as apply,
		):
			extra = get_extra(challan)
		apply.assert_called_once_with(plan)
		self.assertIsNone(extra["plan_rows"][0].get("item"))
		challan.mgk_process_planning = None
		with patch("frappe.get_doc") as load:
			self.assertEqual(get_extra(challan), {"plan_rows": []})
		load.assert_not_called()

	def test_close_process_uses_challan_read_and_field_permissions(self):
		close = frappe.get_doc({"doctype": CLOSE, "delivery_challan": "Preview DC"})
		challan = frappe.get_doc({"doctype": CHALLAN, "process_name": "Dyeing"})
		with (
			patch("frappe.has_permission", return_value=True) as permission,
			patch("frappe.get_doc", return_value=challan) as load,
			patch.object(Document, "apply_fieldlevel_read_permissions", autospec=True) as apply,
		):
			self.assertEqual(get_extra(close), {"process_name": "Dyeing"})
		permission.assert_called_once_with(CHALLAN, "read", doc="Preview DC")
		load.assert_called_once_with(CHALLAN, "Preview DC")
		apply.assert_called_once_with(challan)
		with (
			patch("frappe.has_permission", return_value=True),
			patch("frappe.get_doc", return_value=challan),
			patch.object(
				Document,
				"apply_fieldlevel_read_permissions",
				autospec=True,
				side_effect=lambda doc: doc.set("process_name", None),
			),
		):
			self.assertEqual(get_extra(close), {"process_name": None})

	def test_close_without_readable_challan_has_no_process_extra(self):
		close = frappe.get_doc({"doctype": CLOSE, "delivery_challan": "Preview DC"})
		with patch("frappe.has_permission", return_value=False), patch("frappe.get_doc") as load:
			self.assertEqual(get_extra(close), {})
			close.delivery_challan = None
			self.assertEqual(get_extra(close), {})
		load.assert_not_called()

	def test_receipt_lists_challans_dispatched_from_its_rows(self):
		from mgk_yrp.job_work.dc_from_grn import make_delivery_challan_from_grns

		receipt = make_po_grn(self.make_order())
		worker = make_supplier()
		make_warehouse(supplier=worker)
		result = make_delivery_challan_from_grns([receipt.name], make_process(), worker, 0)
		challan = result["delivery_challan"]
		connections = {
			row["doctype"]: row["names"] for row in get_preview(receipt.doctype, receipt.name)["connections"]
		}
		self.assertIn(challan, connections[CHALLAN])

	def test_filtered_receipt_links_do_not_break_connections_or_enrich_status(self):
		receipt = make_po_grn(self.make_order())

		def filter_links(doc):
			for field in ("purchase_order", "purchase_invoice", "delivery_challans"):
				doc.__dict__.pop(field, None)

		with patch.object(
			Document, "apply_fieldlevel_read_permissions", autospec=True, side_effect=filter_links
		):
			preview = get_preview(receipt.doctype, receipt.name)
		self.assertIsNone(preview["doc"].get("purchase_order"))
		self.assertNotIn("purchase_invoice_docstatus", preview["doc"])
		self.assertNotIn("MGK Purchase Order", [row["doctype"] for row in preview["connections"]])

	def make_invoiced_receipt(self):
		receipt = make_po_grn(self.make_order())
		invoice = make_purchase_invoice(
			against="Purchase Order", supplier=receipt.supplier, grns=[receipt], submit=False
		)
		return receipt, invoice

	def test_readable_invoice_status_is_included(self):
		receipt, invoice = self.make_invoiced_receipt()
		for status in (0, 1, 2):
			frappe.db.set_value(INVOICE, invoice.name, "docstatus", status)
			preview = get_preview(receipt.doctype, receipt.name)
			self.assertEqual(preview["doc"]["purchase_invoice"], invoice.name)
			self.assertEqual(preview["doc"]["purchase_invoice_docstatus"], status)

	def test_invoice_status_is_omitted_without_document_read_permission(self):
		receipt, invoice = self.make_invoiced_receipt()
		original = frappe.has_permission

		def has_permission(doctype, *args, **kwargs):
			if doctype == INVOICE and kwargs.get("doc") == invoice.name:
				return False
			return original(doctype, *args, **kwargs)

		with patch("frappe.has_permission", side_effect=has_permission) as permission:
			preview = get_preview(receipt.doctype, receipt.name)
		permission.assert_any_call(INVOICE, "read", doc=invoice.name)
		self.assertEqual(preview["doc"]["purchase_invoice"], invoice.name)
		self.assertNotIn("purchase_invoice_docstatus", preview["doc"])

	def test_receipt_without_invoice_has_no_invoice_status(self):
		receipt = make_po_grn(self.make_order())
		self.assertNotIn("purchase_invoice_docstatus", get_preview(receipt.doctype, receipt.name)["doc"])
