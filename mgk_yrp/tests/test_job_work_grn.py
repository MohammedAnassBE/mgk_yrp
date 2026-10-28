from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from yrp.stock.utils import get_stock_balance

from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import get_linking_grns
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import make_goods_received_note
from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.tests.fixtures import (
	make_delivery_challan,
	make_item,
	make_job_work_grn,
	make_po_grn,
	make_process,
	make_purchase_order,
	make_return,
	make_supplier,
	make_uom,
	make_warehouse,
)

LOCKING = "mgk_yrp.stock.locking.lock_documents"


class TestJobWorkGRN(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.owner = make_supplier(is_company_location=1)
		self.supplier = make_supplier()
		self.main = make_warehouse(supplier=self.owner)
		self.destination = make_warehouse(supplier=self.supplier)
		self.raw_item = make_item(stock_uom=make_uom("Kg"))
		self.output_item = make_item(stock_uom=make_uom("Kg"))
		self.process_name = make_process()
		self.order = make_purchase_order(
			supplier=self.owner,
			warehouse=self.main,
			items=[{"item": self.raw_item, "qty": 100, "rate": 100}],
		)
		make_po_grn(self.order)

	def make_challan(self, *, submit=True):
		return make_delivery_challan(
			from_warehouse=self.main,
			to_supplier=self.supplier,
			to_warehouse=self.destination,
			process_name=self.process_name,
			items=[{"item": self.raw_item, "qty": 10}],
			submit=submit,
		)

	def make_receipt(self, *, links=(), submit=True, **row):
		return make_job_work_grn(
			supplier=self.supplier,
			warehouse=self.main,
			items=[{"item": self.output_item, "qty": 60, "rate": 10, **row}],
			delivery_challans=links,
			submit=submit,
		)

	def test_job_work_grn_manual_rate_and_stock_rate(self):
		receipt = self.make_receipt()
		receipt.reload()
		self.assertFalse(receipt.against_purchase_order)
		self.assertFalse(receipt.purchase_order)
		self.assertFalse(receipt.items[0].purchase_order_item)
		self.assertEqual((receipt.items[0].rate, receipt.items[0].stock_rate), (10, 10))
		self.assertEqual((receipt.total_qty, receipt.total_amount), (60, 600))
		entries = get_voucher_sles(receipt.doctype, receipt.name)
		self.assertEqual(len(entries), 1)
		self.assertEqual((entries[0].qty, entries[0].rate, entries[0].warehouse), (60, 10, self.main))
		self.assertEqual(get_stock_balance(self.output_item, self.main, with_valuation_rate=True), (60, 10))

	def test_job_work_grn_converts_rate_to_stock_uom(self):
		item = make_item(stock_uom=make_uom("Kg"), purchase_uom=make_uom("Bag"), conversion_factor=50)
		receipt = self.make_receipt(item=item, qty=2, rate=500)
		row = receipt.items[0]
		self.assertEqual((row.uom, row.stock_uom, row.conversion_factor), ("Bag", "Kg", 50))
		self.assertEqual((row.rate, row.stock_rate, row.stock_qty, row.amount), (500, 10, 100, 1000))
		entry = get_voucher_sles(receipt.doctype, receipt.name)[0]
		self.assertEqual((entry.qty, entry.rate, entry.stock_value_difference), (100, 10, 1000))

	def test_zero_rate_posts_with_zero_valuation(self):
		self.make_receipt(rate=25)
		for rate in (None, 0):
			with self.subTest(rate=rate):
				receipt = self.make_receipt(rate=rate, allow_zero_valuation_rate=0)
				self.assertEqual(receipt.items[0].allow_zero_valuation_rate, 1)
				entry = get_voucher_sles(receipt.doctype, receipt.name)[0]
				self.assertEqual((entry.qty, entry.rate, entry.stock_value_difference), (60, 0, 0))
				self.assertEqual((receipt.items[0].stock_rate, receipt.total_amount), (0, 0))

	def test_job_work_grn_rejects_negative_rate_and_nonpositive_quantity(self):
		for row in ({"rate": -1, "allow_zero_valuation_rate": 1}, {"qty": 0}, {"qty": -1}):
			with self.subTest(row=row), self.assertRaises(frappe.ValidationError):
				self.make_receipt(submit=False, **row)

	def test_job_work_grn_rejects_purchase_order_row(self):
		with self.assertRaisesRegex(frappe.ValidationError, "cannot reference a Purchase Order row"):
			self.make_receipt(purchase_order_item=self.order.items[0].name, submit=False)

	def test_grn_links_multiple_dcs_of_same_supplier(self):
		first, second = self.make_challan(), self.make_challan()
		receipt = self.make_receipt(links=[second.name, first.name])
		self.assertEqual(receipt.linked_delivery_challans, [second.name, first.name])
		self.assertEqual(get_linking_grns(first.name, (1,)), [receipt.name])
		self.assertEqual(get_linking_grns(second.name, (1,)), [receipt.name])
		self.assertEqual(len(get_voucher_sles(receipt.doctype, receipt.name)), 1)

	def test_linked_delivery_challans_are_unique_and_ordered(self):
		first, second = self.make_challan(), self.make_challan()
		receipt = self.make_receipt(submit=False)
		for name in (second.name, first.name, second.name):
			receipt.append("delivery_challans", {"delivery_challan": name})
		self.assertEqual(receipt.linked_delivery_challans, [second.name, first.name])

	def test_grn_rejects_dc_of_other_supplier(self):
		challan = self.make_challan()
		with self.assertRaisesRegex(frappe.ValidationError, "same supplier"):
			make_job_work_grn(
				supplier=self.owner,
				warehouse=self.main,
				items=[{"item": self.output_item, "qty": 1, "rate": 10}],
				delivery_challans=[challan.name],
				submit=False,
			)

	def test_grn_rejects_return_or_draft_dc(self):
		challan, draft = self.make_challan(), self.make_challan(submit=False)
		returned = make_return(challan, {challan.items[0].name: 1})
		for source in (draft, returned):
			with self.subTest(source=source.name):
				with self.assertRaisesRegex(frappe.ValidationError, "submitted and non-return"):
					self.make_receipt(links=[source.name], submit=False)

	def test_grn_rejects_cancelled_dc(self):
		challan = self.make_challan()
		challan.cancel()
		with self.assertRaises(frappe.CancelledLinkError):
			self.make_receipt(links=[challan.name], submit=False)
		receipt = self.make_receipt(submit=False)
		receipt.append("delivery_challans", {"delivery_challan": challan.name})
		with self.assertRaisesRegex(frappe.ValidationError, "submitted and non-return"):
			receipt.validate_delivery_challan_links()

	def test_grn_dc_links_require_read_permission(self):
		challan = self.make_challan()
		receipt = self.make_receipt(links=[challan.name], submit=False)
		with patch("frappe.has_permission", side_effect=frappe.PermissionError) as permission:
			with self.assertRaises(frappe.PermissionError):
				receipt.validate_delivery_challan_links()
		self.assertEqual(permission.call_args.args, ("MGK Delivery Challan", "read"))
		self.assertEqual(permission.call_args.kwargs["doc"].name, challan.name)
		self.assertTrue(permission.call_args.kwargs["throw"])

	def test_grn_cannot_link_closed_dc(self):
		challan = self.make_challan()
		linked = self.make_receipt(links=[challan.name], submit=False)
		unlinked = self.make_receipt(submit=False)
		for status in ("Closed", "Reopening"):
			with self.subTest(status=status):
				challan.db_set("close_status", status)
				with self.assertRaisesRegex(frappe.ValidationError, status):
					self.make_receipt(links=[challan.name], submit=False)
				unlinked.reload().append("delivery_challans", {"delivery_challan": challan.name})
				with self.assertRaisesRegex(frappe.ValidationError, status):
					unlinked.save()
				with self.assertRaisesRegex(frappe.ValidationError, status):
					linked.reload().submit()
				self.assertFalse(get_voucher_sles(linked.doctype, linked.name))

	def test_grn_rechecks_dc_state_in_before_submit(self):
		challan = self.make_challan()
		receipt = self.make_receipt(links=[challan.name], submit=False)
		for status in ("Closed", "Reopening"):
			with self.subTest(status=status):
				challan.db_set("close_status", status, update_modified=False)
				with self.assertRaisesRegex(frappe.ValidationError, status):
					receipt.before_submit()
		self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))

	def test_grn_rechecks_dc_state_after_lock(self):
		challan = self.make_challan()
		receipt = self.make_receipt(links=[challan.name], submit=False)

		def close_after_lock(documents):
			lock_documents(documents)
			challan.db_set("close_status", "Closed", update_modified=False)

		with patch(LOCKING, side_effect=close_after_lock):
			with self.assertRaisesRegex(frappe.ValidationError, "Closed"):
				receipt.validate_delivery_challan_links()
		self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))

	def test_draft_link_locks_dc(self):
		challan = self.make_challan()
		receipt = self.make_receipt(submit=False)
		with patch(LOCKING, wraps=lock_documents) as locks:
			receipt.append("delivery_challans", {"delivery_challan": challan.name})
			receipt.save()
		self.assert_dc_locked(locks, challan.name)
		with patch(LOCKING, wraps=lock_documents) as locks:
			receipt.set("delivery_challans", [])
			receipt.save()
		self.assert_dc_locked(locks, challan.name)
		self.assertEqual(get_linking_grns(challan.name, (0, 1)), [])
		receipt.append("delivery_challans", {"delivery_challan": challan.name})
		receipt.save()
		with patch(LOCKING, wraps=lock_documents) as locks:
			receipt.submit()
		self.assert_dc_locked(locks, challan.name)
		self.assertTrue(any("MGK Goods Received Note" in call.args[0] for call in locks.call_args_list))

	def assert_dc_locked(self, locks, name):
		self.assertTrue(
			any(name in call.args[0].get("MGK Delivery Challan", []) for call in locks.call_args_list)
		)

	def test_draft_link_replacement_locks_old_and_new_dcs(self):
		first, second = self.make_challan(), self.make_challan()
		receipt = self.make_receipt(links=[first.name], submit=False)
		with patch(LOCKING, wraps=lock_documents) as locks:
			receipt.set("delivery_challans", [{"delivery_challan": second.name}])
			receipt.save()
		self.assertTrue(
			any(
				set(call.args[0].get("MGK Delivery Challan", [])) == {first.name, second.name}
				for call in locks.call_args_list
			)
		)
		self.assertEqual(get_linking_grns(first.name, (0, 1)), [])
		self.assertEqual(get_linking_grns(second.name, (0,)), [receipt.name])

	def test_source_locks_precede_frappe_receipt_lock(self):
		challan = self.make_challan()
		receipt = self.make_receipt(links=[challan.name], submit=False)
		with patch("frappe.db.sql", wraps=frappe.db.sql) as queries:
			receipt.save()
		locking_queries = [
			str(call.args[0]) for call in queries.call_args_list if "FOR UPDATE" in str(call.args[0])
		]
		first_challan = next(
			index for index, sql in enumerate(locking_queries) if "`tabMGK Delivery Challan`" in sql
		)
		first_receipt = next(
			index for index, sql in enumerate(locking_queries) if "`tabMGK Goods Received Note`" in sql
		)
		self.assertLess(first_challan, first_receipt)

	def test_grn_has_no_consumption_fields(self):
		meta = frappe.get_meta("MGK Goods Received Note")
		for field in meta.fields:
			self.assert_no_consumption_field(field)
			if field.fieldtype in ("Table", "Table MultiSelect"):
				for child_field in frappe.get_meta(field.options).fields:
					self.assert_no_consumption_field(child_field)

	def assert_no_consumption_field(self, field):
		text = f"{field.fieldname} {field.label} {field.options}".lower()
		self.assertNotIn("consum", text)
		self.assertNotIn("used_qty", text)

	def test_po_grn_cannot_link_dc(self):
		challan = self.make_challan()
		order = make_purchase_order(
			supplier=self.supplier,
			warehouse=self.main,
			items=[{"item": self.output_item, "qty": 60, "rate": 10}],
		)
		receipt = make_goods_received_note(order.name)
		receipt.append("delivery_challans", {"delivery_challan": challan.name})
		with self.assertRaisesRegex(frappe.ValidationError, "Purchase Order receipt cannot link"):
			receipt.insert(ignore_permissions=True)

	def test_grn_cancel_blocked_when_dc_closed(self):
		open_challan, challan = self.make_challan(), self.make_challan()
		receipt = self.make_receipt(links=[open_challan.name, challan.name])
		names = [entry.name for entry in get_voucher_sles(receipt.doctype, receipt.name)]
		for status in ("Closed", "Reopening"):
			with self.subTest(status=status):
				challan.db_set("close_status", status)
				with self.assertRaisesRegex(frappe.ValidationError, "reopen it before cancelling this GRN"):
					receipt.reload().cancel()
				self.assertEqual(frappe.db.get_value(receipt.doctype, receipt.name, "docstatus"), 1)
				self.assertEqual(
					[entry.name for entry in get_voucher_sles(receipt.doctype, receipt.name)], names
				)
		challan.db_set("close_status", "Open")
		with patch(LOCKING, wraps=lock_documents) as locks:
			receipt.reload().cancel()
		self.assert_dc_locked(locks, challan.name)
		self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))
		self.assertEqual(get_stock_balance(self.output_item, self.main), 0)

	def test_dc_cancel_blocked_by_linking_grn(self):
		challan = self.make_challan()
		receipt = self.make_receipt(links=[challan.name], submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, receipt.name):
			challan.cancel()
		receipt.submit()
		with self.assertRaisesRegex(frappe.ValidationError, receipt.name):
			challan.reload().cancel()
		receipt.cancel()
		challan.reload().cancel()
		self.assertFalse(get_voucher_sles(challan.doctype, challan.name))

	def test_grn_cancel_checks_persisted_dc_links(self):
		challan = self.make_challan()
		receipt = self.make_receipt(links=[challan.name])
		challan.db_set("close_status", "Closed")
		receipt.set("delivery_challans", [])
		with self.assertRaisesRegex(frappe.ValidationError, "reopen it before cancelling this GRN"):
			receipt.cancel()
		self.assertEqual(get_linking_grns(challan.name, (1,)), [receipt.name])
		self.assertTrue(get_voucher_sles(receipt.doctype, receipt.name))

	def test_draft_link_removal_allows_dc_cancel(self):
		challan = self.make_challan()
		receipt = self.make_receipt(links=[challan.name], submit=False)
		receipt.set("delivery_challans", [])
		receipt.save()
		challan.cancel()
		self.assertFalse(get_voucher_sles(challan.doctype, challan.name))

	def test_get_linking_grns_filters_status_and_deduplicates(self):
		challan = self.make_challan()
		draft = self.make_receipt(links=[challan.name], submit=False)
		submitted = self.make_receipt(links=[challan.name])
		duplicate = draft.append("delivery_challans", {"delivery_challan": challan.name})
		duplicate.db_insert()
		self.assertEqual(get_linking_grns(challan.name, (0,)), [draft.name])
		self.assertEqual(get_linking_grns(challan.name, (1,)), [submitted.name])
		self.assertEqual(get_linking_grns(challan.name, (0, 1)), sorted([draft.name, submitted.name]))
		self.assertEqual(get_linking_grns(challan.name, ()), [])
		submitted.cancel()
		self.assertEqual(get_linking_grns(challan.name, (0, 1)), [draft.name])
		self.assertEqual(get_linking_grns(challan.name, (2,)), [submitted.name])
