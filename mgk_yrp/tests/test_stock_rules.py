from datetime import timedelta
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, now_datetime, nowdate
from yrp.stock.stock_ledger import make_sl_entries
from yrp.stock.utils import get_combine_datetime, get_stock_balance
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	register_production_links,
)

from mgk_yrp.stock.backdating import (
	has_later_linked_movements,
	is_backdated,
	validate_backdated_cancel,
	validate_backdated_posting,
)
from mgk_yrp.stock.ledger import (
	assert_transfer_pairs,
	get_voucher_sles,
	post_stock_entries,
	receipt_entry,
	transfer_entries,
)
from mgk_yrp.tests.fixtures import (
	make_item,
	make_po_grn,
	make_purchase_order,
	make_supplier,
	make_uom,
	make_warehouse,
)


class TestStockRules(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.supplier = make_supplier()
		self.warehouse = make_warehouse(supplier=self.supplier)
		self.destination = make_warehouse()
		self.item = make_item(stock_uom=make_uom("Kg"))
		self.posting_date = add_days(nowdate(), -1)
		self.buckets = [(self.item, self.warehouse)]
		self.original_user = frappe.session.user
		self.addCleanup(frappe.set_user, self.original_user)

	def make_order(self):
		return make_purchase_order(
			supplier=self.supplier,
			warehouse=self.warehouse,
			items=[{"item": self.item, "qty": 100, "rate": 100}],
		)

	def make_receipt(self, posting_time="09:00:00", *, submit=True):
		receipt = make_po_grn(self.make_order(), submit=False)
		receipt.edit_posting_date_and_time = 1
		receipt.posting_date = self.posting_date
		receipt.posting_time = posting_time
		if submit:
			receipt.submit()
		return receipt

	def post_transfer(self, posting_time="12:00:00"):
		order = self.make_order()
		voucher = frappe._dict(
			doctype=order.doctype,
			name=order.name,
			posting_date=self.posting_date,
			posting_time=posting_time,
		)
		row = order.items[0]
		row.stock_qty = 10
		entries = transfer_entries(
			voucher,
			row,
			from_warehouse=self.warehouse,
			to_warehouse=self.destination,
		)
		post_stock_entries(entries)
		assert_transfer_pairs(voucher.doctype, voucher.name)
		return voucher, entries

	def make_stock_user(self, *, is_manager=False):
		email = f"mgk-stock-{frappe.generate_hash(length=8)}@example.com"
		roles = ["Stock User"]
		if is_manager:
			roles.append("Stock Manager")
		frappe.get_doc(
			{
				"doctype": "User",
				"email": email,
				"first_name": "MGK Stock Test",
				"send_welcome_email": 0,
				"user_type": "System User",
				"roles": [{"role": role} for role in roles],
			}
		).insert(ignore_permissions=True)
		return email

	def test_posting_uses_inline_details(self):
		with patch("mgk_yrp.stock.ledger.make_sl_entries", wraps=make_sl_entries) as posting:
			receipt = make_po_grn(self.make_order())
		self.assertEqual(
			posting.call_args.kwargs,
			{
				"cancel": False,
				"return_details": True,
				"force_inline": True,
			},
		)
		with patch("mgk_yrp.stock.ledger.make_sl_entries", wraps=make_sl_entries) as posting:
			receipt.cancel()
		self.assertEqual(
			posting.call_args.kwargs,
			{
				"cancel": True,
				"return_details": True,
				"force_inline": True,
			},
		)

	def test_stock_dimensions_rejected(self):
		receipt = make_po_grn(self.make_order(), submit=False)
		with patch("mgk_yrp.stock.ledger.get_dimension_fieldnames", return_value=["lot"]):
			with self.assertRaisesRegex(frappe.ValidationError, r"Stock dimensions are configured \(lot\)"):
				receipt.submit()
		self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))
		receipt.reload().submit()
		with patch("mgk_yrp.stock.ledger.get_dimension_fieldnames", return_value=["lot"]):
			with self.assertRaisesRegex(frappe.ValidationError, "does not support"):
				receipt.cancel()
		self.assertTrue(get_voucher_sles(receipt.doctype, receipt.name))
		self.assertEqual(frappe.db.get_value(receipt.doctype, receipt.name, "docstatus"), 1)

	def test_backdated_post_requires_stock_manager(self):
		receipt = self.make_receipt(submit=False)
		stock_user = self.make_stock_user()
		manager = self.make_stock_user(is_manager=True)
		frappe.set_user(stock_user)
		with self.assertRaises(frappe.PermissionError):
			validate_backdated_posting(receipt, self.buckets)
		frappe.set_user(manager)
		validate_backdated_posting(receipt, self.buckets)
		self.assertTrue(is_backdated(receipt))

	def test_unedited_posting_datetime_is_stamped_now(self):
		receipt = make_po_grn(self.make_order(), submit=False)
		receipt.posting_date = self.posting_date
		receipt.posting_time = "00:00:00"
		before = now_datetime()
		receipt.submit()
		self.assertGreaterEqual(get_combine_datetime(receipt.posting_date, receipt.posting_time), before)
		self.assertFalse(is_backdated(receipt))

	def test_backdated_post_rejected_before_later_linked_movement(self):
		self.make_receipt()
		self.post_transfer()
		receipt = self.make_receipt("11:00:00", submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "later linked movements"):
			receipt.submit()
		self.assertFalse(get_voucher_sles(receipt.doctype, receipt.name))
		self.assertEqual(get_stock_balance(self.item, self.warehouse), 90)

	def test_same_timestamp_counts_as_later(self):
		self.make_receipt()
		voucher, _entries = self.post_transfer()
		posting_datetime = get_combine_datetime(voucher.posting_date, voucher.posting_time)
		self.assertTrue(has_later_linked_movements(self.buckets, posting_datetime, ("", "")))
		self.assertFalse(
			has_later_linked_movements(
				self.buckets,
				posting_datetime,
				(voucher.doctype, voucher.name),
			)
		)
		receipt = self.make_receipt("12:00:00", submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "later linked movements"):
			receipt.submit()

	def test_incoming_transfer_leg_blocks_backdating(self):
		self.make_receipt()
		voucher, _entries = self.post_transfer()
		self.assertTrue(
			has_later_linked_movements(
				[(self.item, self.destination)],
				get_combine_datetime(voucher.posting_date, "11:00:00"),
				("", ""),
			)
		)

	def test_backdated_cancel_rejected_before_later_linked_movement(self):
		receipt = self.make_receipt()
		self.post_transfer()
		old_names = [row.name for row in get_voucher_sles(receipt.doctype, receipt.name)]
		with self.assertRaisesRegex(frappe.ValidationError, "later linked movements"):
			receipt.cancel()
		self.assertEqual([row.name for row in get_voucher_sles(receipt.doctype, receipt.name)], old_names)
		self.assertEqual(frappe.db.get_value(receipt.doctype, receipt.name, "docstatus"), 1)
		order = frappe.get_doc("MGK Purchase Order", receipt.purchase_order)
		self.assertEqual(order.items[0].received_qty, 100)

	def test_backdated_cancel_requires_manager_for_later_plain_receipt(self):
		receipt = self.make_receipt()
		self.make_receipt("10:00:00")
		stock_user = self.make_stock_user()
		manager = self.make_stock_user(is_manager=True)
		frappe.set_user(stock_user)
		with self.assertRaises(frappe.PermissionError):
			validate_backdated_cancel(receipt)
		frappe.set_user(manager)
		validate_backdated_cancel(receipt)

	def test_cancel_without_later_movement_does_not_require_manager(self):
		receipt = self.make_receipt()
		stock_user = self.make_stock_user()
		frappe.set_user(stock_user)
		validate_backdated_cancel(receipt)

	def test_cancelled_transfer_does_not_block_backdating(self):
		self.make_receipt()
		voucher, entries = self.post_transfer()
		post_stock_entries(entries, cancel=True)
		self.assertFalse(get_voucher_sles(voucher.doctype, voucher.name))
		self.make_receipt("11:00:00")

	def test_production_consumption_blocks_backdating_only_while_active(self):
		self.make_receipt()
		order = self.make_order()
		voucher = frappe._dict(
			doctype=order.doctype,
			name=order.name,
			posting_date=self.posting_date,
			posting_time="12:00:00",
		)
		consumption = receipt_entry(voucher, order.items[0], self.warehouse)
		consumption.update(qty=-10, rate=0, _result_key="consumption")
		result = post_stock_entries([consumption])
		output = self.make_receipt("13:00:00")
		consumption_name = result["entries"]["consumption"]["sle"]
		register_production_links(
			voucher.doctype,
			voucher.name,
			[
				{
					"consumption_sle": consumption_name,
					"output_receipt_sle": get_voucher_sles(output.doctype, output.name)[0].name,
					"allocation_weight": 10,
					"input_quantity": 10,
					"source_row": order.items[0].name,
				}
			],
		)
		posting_datetime = get_combine_datetime(self.posting_date, "11:00:00")
		self.assertTrue(has_later_linked_movements(self.buckets, posting_datetime, ("", "")))
		frappe.db.set_value(
			"YRP Stock Valuation Production Link",
			{"consumption_sle": consumption_name},
			"active",
			0,
		)
		self.assertFalse(has_later_linked_movements(self.buckets, posting_datetime, ("", "")))

	def test_transfer_entries_preserve_actual_value_and_pairs(self):
		self.make_receipt()
		voucher, entries = self.post_transfer()
		self.assertEqual([entry["qty"] for entry in entries], [-10, 10])
		self.assertEqual([entry["rate"] for entry in entries], [0, 0])
		ledgers = get_voucher_sles(voucher.doctype, voucher.name)
		self.assertEqual(len(ledgers), 2)
		self.assertEqual(sum(row.stock_value_difference for row in ledgers), 0)
		self.assertEqual(get_stock_balance(self.item, self.destination, with_valuation_rate=True), (10, 100))
		frappe.db.set_value("YRP Stock Ledger Entry", ledgers[0].name, "paired_stock_ledger_entry", None)
		with self.assertRaisesRegex(frappe.ValidationError, "Incomplete stock transfer pair"):
			assert_transfer_pairs(voucher.doctype, voucher.name)

	def test_future_post_does_not_require_manager(self):
		receipt = self.make_receipt(submit=False)
		future = now_datetime() + timedelta(hours=1)
		receipt.posting_date, receipt.posting_time = future.date(), future.time()
		stock_user = self.make_stock_user()
		frappe.set_user(stock_user)
		validate_backdated_posting(receipt, self.buckets)
		self.assertFalse(is_backdated(receipt))
