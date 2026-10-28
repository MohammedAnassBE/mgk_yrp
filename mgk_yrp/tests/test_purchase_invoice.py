from unittest.mock import Mock, patch

import frappe
from frappe.model.document import Document

from mgk_yrp.job_work.reopen import finish_reopen
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice import (
	get_grn_rows,
	get_unbilled_grns,
)
from mgk_yrp.purchase.revaluation import build_invoice_allocations, create_adjustment
from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.tests.close_fixtures import ADJUSTMENT, CloseTestCase
from mgk_yrp.tests.fixtures import (
	close_dc,
	make_item,
	make_job_work_grn,
	make_purchase_invoice,
	make_supplier,
	make_uom,
	run_adjustments,
)

INVOICE = "mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice"
REVALUATION = "mgk_yrp.purchase.revaluation"


class TestPurchaseInvoice(CloseTestCase):
	def setUp(self):
		super().setUp()
		setting = patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=True)
		setting.start()
		self.addCleanup(setting.stop)

	def make_invoice(self, receipts, *, against="Job Work", supplier=None, rates=None, submit=True):
		return make_purchase_invoice(
			against=against, supplier=supplier or self.supplier, grns=receipts, rates=rates, submit=submit
		)

	def draft_from_rows(self, rows, *, supplier=None, against="Job Work"):
		return frappe.get_doc(
			{
				"doctype": "MGK Purchase Invoice",
				"supplier": supplier or self.supplier,
				"against": against,
				"items": rows,
			}
		)

	def make_reopening_chain(self):
		first = self.make_challan()
		intermediate = self.make_output([first])
		upstream = close_dc(first)
		run_adjustments(upstream.doctype, upstream.name)
		second = self.make_challan(items=[{"item": self.output_item, "qty": 60}])
		finished = make_item(stock_uom=make_uom("Kg"))
		receipt = self.make_output([second], items=[{"item": finished, "qty": 60, "rate": 1}])
		downstream = close_dc(second)
		run_adjustments(downstream.doctype, downstream.name)
		downstream.cancel()
		run_adjustments(downstream.doctype, downstream.name)
		self.assertEqual(self.get_overlay(receipt), 0)
		self.assertTrue(self.get_links(downstream))
		return downstream, intermediate, receipt

	def test_c67_c82_downward_upstream_pi_waits_between_reversal_and_finish(self):
		purchase = self.make_input()
		downstream, intermediate, receipt = self.make_reopening_chain()
		invoice = self.make_invoice(
			[purchase],
			supplier=self.owner,
			against="Purchase Order",
			rates={purchase.items[0].name: 90},
			submit=False,
		)
		with patch(f"{REVALUATION}.create_adjustment", wraps=create_adjustment) as create:
			with self.assertRaisesRegex(frappe.ValidationError, downstream.name):
				invoice.submit()
			create.assert_not_called()
		self.assertEqual(frappe.db.get_value(invoice.doctype, invoice.name, "docstatus"), 0)
		self.assertTrue(finish_reopen(downstream.name))
		invoice.reload().submit()
		run_adjustments(invoice.doctype, invoice.name)
		self.assertAlmostEqual(self.get_overlay(intermediate), 4500, places=5)
		self.assertEqual(self.get_overlay(receipt), 0)

	def test_c67_c82_downward_pi_cancellation_waits_between_reversal_and_finish(self):
		purchase = self.make_input()
		invoice = self.make_invoice(
			[purchase], supplier=self.owner, against="Purchase Order", rates={purchase.items[0].name: 110}
		)
		run_adjustments(invoice.doctype, invoice.name)
		downstream, intermediate, receipt = self.make_reopening_chain()
		with patch(f"{INVOICE}.create_reversal") as reverse:
			with self.assertRaisesRegex(frappe.ValidationError, downstream.name):
				invoice.cancel()
			reverse.assert_not_called()
		self.assertEqual(frappe.db.get_value(invoice.doctype, invoice.name, "docstatus"), 1)
		self.assertEqual(purchase.reload().purchase_invoice, invoice.name)
		self.assertTrue(finish_reopen(downstream.name))
		invoice.reload().cancel()
		run_adjustments(invoice.doctype, invoice.name)
		self.assertAlmostEqual(self.get_overlay(intermediate), 5000, places=5)
		self.assertEqual(self.get_overlay(receipt), 0)

	def test_get_unbilled_grns_filters_by_type_and_billing(self):
		purchase = self.make_input()
		job = self.make_output([])
		draft = self.make_output([], submit=False)
		other = make_job_work_grn(
			supplier=self.owner,
			warehouse=self.main,
			items=[{"item": self.output_item, "qty": 1, "rate": 10}],
		)
		self.assertEqual(
			[row.name for row in get_unbilled_grns(self.owner, "Purchase Order")], [purchase.name]
		)
		self.assertEqual([row.name for row in get_unbilled_grns(self.supplier, "Job Work")], [job.name])
		self.assertFalse(get_unbilled_grns(self.supplier, "Purchase Order"))
		with patch(f"{INVOICE}.frappe.get_list", wraps=frappe.get_list) as listing:
			get_unbilled_grns(self.supplier, "Job Work")
		self.assertTrue(listing.called)
		self.make_invoice([job], submit=False)
		self.assertFalse(get_unbilled_grns(self.supplier, "Job Work"))
		self.assertNotIn(draft.name, [row.name for row in get_unbilled_grns(self.supplier, "Job Work")])
		self.assertIn(other.name, [row.name for row in get_unbilled_grns(self.owner, "Job Work")])

	def test_pi_fetches_full_grn_rows_with_editable_rate(self):
		receipt = self.make_output(
			[], items=[{"item": self.output_item, "qty": quantity, "rate": 10} for quantity in (10, 20)]
		)
		rows = get_grn_rows(frappe.as_json([receipt.name]))
		self.assertEqual(len(rows), 2)
		self.assertEqual([row.qty for row in rows], [10, 20])
		self.assertEqual([row.grn_rate for row in rows], [10, 10])
		invoice = self.make_invoice([receipt], rates={receipt.items[0].name: 15}, submit=False)
		self.assertEqual((invoice.items[0].rate, invoice.items[0].grn_rate), (15, 10))
		self.assertEqual(invoice.net_total, 350)
		fields = frappe.get_meta("MGK Purchase Invoice Item").fields
		self.assertEqual({field.fieldname for field in fields if not field.read_only}, {"rate"})

	def test_pi_rejects_partial_grn(self):
		receipt = self.make_output(
			[], items=[{"item": self.output_item, "qty": quantity, "rate": 10} for quantity in (10, 20)]
		)
		for mode in ("missing", "reduced", "duplicate"):
			with self.subTest(mode=mode):
				rows = get_grn_rows([receipt.name])
				if mode == "missing":
					rows.pop()
				elif mode == "reduced":
					rows[0].qty = 1
				else:
					rows.append(rows[0].copy())
				with self.assertRaisesRegex(frappe.ValidationError, "Full-GRN"):
					self.draft_from_rows(rows).insert(ignore_permissions=True)

	def test_grn_billed_once(self):
		receipt = self.make_output([])
		stale_rows = get_grn_rows([receipt.name])
		first = self.make_invoice([receipt], submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "already billed"):
			self.draft_from_rows(stale_rows).insert(ignore_permissions=True)
		self.assertEqual(receipt.reload().purchase_invoice, first.name)

	def test_grn_list_billing_status_tracks_invoice_submission(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], submit=False)
		for expected_status in (0, 1):
			if expected_status:
				invoice.submit()
			rows = frappe.get_list(
				"MGK Goods Received Note",
				filters={"name": receipt.name},
				fields=["purchase_invoice", "purchase_invoice.docstatus as purchase_invoice_docstatus"],
			)
			self.assertEqual(rows[0].purchase_invoice, invoice.name)
			self.assertEqual(rows[0].purchase_invoice_docstatus, expected_status)
		invoice.cancel()
		self.assertFalse(receipt.reload().purchase_invoice)

	def test_pi_save_stores_and_clears_grn_link(self):
		first, second = self.make_output([]), self.make_output([])
		invoice = self.make_invoice([first, second], submit=False)
		self.assertEqual(first.reload().purchase_invoice, invoice.name)
		invoice.set("items", [row for row in invoice.items if row.goods_received_note == second.name])
		invoice.save()
		self.assertFalse(first.reload().purchase_invoice)
		self.assertEqual(second.reload().purchase_invoice, invoice.name)
		invoice.delete(ignore_permissions=True)
		self.assertFalse(second.reload().purchase_invoice)
		invoice = self.make_invoice([first])
		invoice.cancel()
		self.assertFalse(first.reload().purchase_invoice)
		self.make_invoice([first], submit=False)

	def test_pi_rejects_other_supplier_or_type(self):
		receipt = self.make_output([])
		for header in ({"supplier": self.owner}, {"against": "Purchase Order"}, {"against": "Other"}):
			with self.subTest(header=header), self.assertRaises(frappe.ValidationError):
				self.draft_from_rows(get_grn_rows([receipt.name]), **header).insert(ignore_permissions=True)

	def test_pi_rejects_draft_or_cancelled_grn(self):
		for submitted in (False, True):
			receipt = self.make_output([], submit=submitted)
			if submitted:
				receipt.cancel()
			with self.assertRaisesRegex(frappe.ValidationError, "must be submitted"):
				get_grn_rows([receipt.name])

	def test_grn_to_pi_requires_read_permission(self):
		receipt = self.make_output([])
		rows = get_grn_rows([receipt.name])
		original = Document.check_permission

		def deny_receipt(document, *args, **kwargs):
			if document.doctype == receipt.doctype:
				raise frappe.PermissionError
			return original(document, *args, **kwargs)

		with patch.object(Document, "check_permission", deny_receipt):
			with self.assertRaises(frappe.PermissionError):
				get_grn_rows([receipt.name])
			with self.assertRaises(frappe.PermissionError):
				self.draft_from_rows(rows).insert(ignore_permissions=True)

	def test_pi_validates_uom_and_source_identity(self):
		receipt = self.make_output([])
		for field, value in (
			("uom", "Nos"),
			("conversion_factor", 50),
			("item", self.raw_item),
			("goods_received_note_item", "foreign-row"),
			("rate", -1),
		):
			rows = get_grn_rows([receipt.name])
			rows[0][field] = value
			with self.subTest(field=field), self.assertRaises(frappe.ValidationError):
				self.draft_from_rows(rows).insert(ignore_permissions=True)

	def test_pi_recomputes_read_only_values(self):
		receipt = self.make_output([])
		rows = get_grn_rows([receipt.name])
		rows[0].update(grn_rate=999, stock_qty=1, amount=999, gst_rate=99)
		invoice = self.draft_from_rows(rows).insert(ignore_permissions=True)
		self.assertEqual(
			(invoice.items[0].grn_rate, invoice.items[0].stock_qty, invoice.net_total), (10, 60, 600)
		)

	def test_pi_rate_change_creates_adjustment(self):
		receipt = self.make_input(quantity=100)
		invoice = self.make_invoice(
			[receipt], supplier=self.owner, against="Purchase Order", rates={receipt.items[0].name: 110}
		)
		adjustments = run_adjustments(invoice.doctype, invoice.name)
		self.assertEqual(len(adjustments), 1)
		adjustment = frappe.get_doc("YRP Stock Valuation Adjustment", adjustments[0])
		self.assertEqual(adjustment.source_allocations[0].difference, 1000)
		self.assertEqual(self.get_overlay(receipt), 1000)

	def test_pi_includes_zero_difference_targets(self):
		first, second = self.make_output([]), self.make_output([])
		with patch(f"{REVALUATION}.create_adjustment", wraps=create_adjustment) as create:
			self.make_invoice([first, second], rates={first.items[0].name: 11})
		allocations = create.call_args.kwargs["allocations"]
		self.assertEqual(len(allocations), 2)
		self.assertEqual(sorted(row["difference"] for row in allocations), [0, 60])
		self.assertEqual(len({row["target_sle"] for row in allocations}), 2)

	def test_pi_difference_uses_commercial_qty(self):
		item = make_item(stock_uom=make_uom("Kg"), purchase_uom=make_uom("Bag"), conversion_factor=50)
		receipt = self.make_output([], items=[{"item": item, "qty": 2, "rate": 5000}])
		invoice = self.make_invoice([receipt], rates={receipt.items[0].name: 5100})
		allocation = build_invoice_allocations(invoice)[0]
		self.assertEqual(
			(allocation["difference"], allocation["old_rate"], allocation["new_rate"]), (200, 100, 102)
		)
		self.assertEqual((allocation["quantity"], allocation["allocation_weight"]), (100, 100))
		run_adjustments(invoice.doctype, invoice.name)
		self.assertEqual(self.get_overlay(receipt), 200)

	def test_pi_throws_when_adjustment_setting_off(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], rates={receipt.items[0].name: 11}, submit=False)
		with patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=False):
			with self.assertRaisesRegex(frappe.ValidationError, "Enable Apply Stock Adjustment"):
				invoice.submit()
		self.assertFalse(frappe.db.exists("YRP Stock Valuation Adjustment", {"source_name": invoice.name}))

	def test_pi_same_rate_rejected_when_setting_off(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], submit=False)
		with (
			patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=False),
			patch(f"{ADJUSTMENT}.is_stock_adjustment_enabled", return_value=False),
		):
			with self.assertRaisesRegex(frappe.ValidationError, "Enable Apply Stock Adjustment"):
				invoice.submit()
		self.assertEqual(frappe.db.get_value(invoice.doctype, invoice.name, "docstatus"), 0)
		self.assertFalse(frappe.db.exists("YRP Stock Valuation Adjustment", {"source_name": invoice.name}))

	def test_pi_cancel_creates_reversal_even_when_setting_off(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], rates={receipt.items[0].name: 11})
		run_adjustments(invoice.doctype, invoice.name)
		with (
			patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=False),
			patch(f"{ADJUSTMENT}.is_stock_adjustment_enabled", return_value=False),
		):
			invoice.cancel()
		self.assertFalse(receipt.reload().purchase_invoice)
		names = run_adjustments(invoice.doctype, invoice.name)
		self.assertEqual(len(names), 2)
		self.assertEqual(self.get_overlay(receipt), 0)
		reversal = frappe.get_doc("YRP Stock Valuation Adjustment", names[-1])
		self.assertEqual((reversal.adjustment_type, reversal.total_source_difference), ("Reversal", -60))
		receipt.cancel()

	def test_pi_cancel_preflight_blocks_before_mutation(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], rates={receipt.items[0].name: 11})
		run_adjustments(invoice.doctype, invoice.name)
		entry = get_voucher_sles(receipt.doctype, receipt.name)[0]
		frappe.db.set_value("YRP Stock Ledger Entry", entry.name, "is_cancelled", 1)
		with patch(f"{INVOICE}.create_reversal", wraps=None) as reverse:
			with self.assertRaises(frappe.ValidationError):
				invoice.cancel()
			reverse.assert_not_called()
		self.assertEqual(receipt.reload().purchase_invoice, invoice.name)
		self.assertEqual(frappe.db.get_value(invoice.doctype, invoice.name, "docstatus"), 1)

	def test_grn_cancel_blocked_by_pi(self):
		for submitted in (False, True):
			receipt = self.make_output([])
			invoice = self.make_invoice([receipt], submit=submitted)
			with (
				self.subTest(submitted=submitted),
				self.assertRaisesRegex(frappe.ValidationError, "Cancel Purchase Invoice"),
			):
				receipt.cancel()
			self.assertEqual(receipt.reload().docstatus, 1)
			self.assertEqual(receipt.purchase_invoice, invoice.name)

	def test_pi_waits_for_pending_close_adjustment(self):
		for changed in (False, True):
			challan, receipt = self.make_cycle()
			close_dc(challan)
			invoice = self.make_invoice(
				[receipt], rates={receipt.items[0].name: 11 if changed else 10}, submit=False
			)
			with (
				self.subTest(changed=changed),
				self.assertRaisesRegex(frappe.ValidationError, "still Queued"),
			):
				invoice.submit()
			self.assertFalse(
				frappe.db.exists("YRP Stock Valuation Adjustment", {"source_name": invoice.name})
			)

	def test_pi_mixed_revision_waits_on_zero_difference_target(self):
		challan, unchanged = self.make_cycle()
		close_dc(challan)
		changed = self.make_output([])
		invoice = self.make_invoice([unchanged, changed], rates={changed.items[0].name: 11}, submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "still Queued"):
			invoice.submit()

	def test_pi_after_dc_close_adds_to_overlay(self):
		challan, receipt = self.make_cycle()
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		invoice = self.make_invoice([receipt], rates={receipt.items[0].name: 11})
		run_adjustments(invoice.doctype, invoice.name)
		self.assertEqual(self.get_overlay(receipt), 5060)
		invoice.cancel()
		run_adjustments(invoice.doctype, invoice.name)
		self.assertEqual(self.get_overlay(receipt), 5000)

	def test_po_pi_revaluation_flows_through_closed_dc(self):
		purchase = self.make_input()
		challan = self.make_challan()
		receipt = self.make_output([challan])
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		invoice = self.make_invoice(
			[purchase], supplier=self.owner, against="Purchase Order", rates={purchase.items[0].name: 110}
		)
		run_adjustments(invoice.doctype, invoice.name)
		self.assertAlmostEqual(self.get_overlay(receipt), 5500, places=5)
		incoming = next(row for row in get_voucher_sles(challan.doctype, challan.name) if row.qty > 0)
		self.assertAlmostEqual(incoming.valuation_adjustment_value, 500, places=5)
		with self.assertRaisesRegex(frappe.ValidationError, f"MGK Purchase Invoice {invoice.name}"):
			close.cancel()

	def test_pi_missing_receipt_target_throws(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], submit=False)
		with patch(f"{REVALUATION}.find_receipt_sle", return_value=None):
			with self.assertRaisesRegex(frappe.ValidationError, "Missing receipt"):
				invoice.submit()

	def test_pi_allows_zero_final_rate(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], rates={receipt.items[0].name: 0})
		run_adjustments(invoice.doctype, invoice.name)
		self.assertEqual((invoice.net_total, self.get_overlay(receipt)), (0, -600))

	def test_pi_amend_waits_for_reversal_then_creates_fresh_adjustment(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], rates={receipt.items[0].name: 11})
		run_adjustments(invoice.doctype, invoice.name)
		invoice.cancel()
		amended = frappe.copy_doc(invoice)
		amended.docstatus = 0
		amended.amended_from = invoice.name
		amended.items[0].rate = 12
		amended.insert(ignore_permissions=True)
		frappe.db.savepoint("invoice_amend_submit")
		with self.assertRaisesRegex(frappe.ValidationError, "still Reversal Queued"):
			amended.submit()
		frappe.db.rollback(save_point="invoice_amend_submit")
		run_adjustments(invoice.doctype, invoice.name)
		amended.reload().submit()
		self.assertNotEqual(amended.name, invoice.name)
		self.assertEqual(len(run_adjustments(amended.doctype, amended.name)), 1)
		self.assertEqual(self.get_overlay(receipt), 120)

	def test_pi_cancel_uses_persisted_grn_links(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt])
		invoice.set("items", [])
		invoice.net_total = 999
		invoice.supplier_gstin = "tampered"
		invoice.cancel()
		self.assertFalse(receipt.reload().purchase_invoice)
		self.assertEqual(len(invoice.items), 1)
		self.assertEqual(invoice.net_total, 600)
		self.assertFalse(invoice.supplier_gstin)

	def test_pi_locks_grns_before_invoice_and_rechecks_billing(self):
		receipt = self.make_output([])
		invoice = self.make_invoice([receipt], submit=False)
		sequence = Mock()
		with (
			patch("mgk_yrp.stock.dependencies.lock_documents", wraps=lock_documents) as parents,
			patch.object(
				Document, "load_doc_before_save", autospec=True, wraps=Document.load_doc_before_save
			) as load,
		):
			sequence.attach_mock(parents, "parents")
			sequence.attach_mock(load, "invoice")
			invoice.load_doc_before_save()
		self.assertEqual(sequence.mock_calls[0].args[0]["MGK Goods Received Note"], {receipt.name})
		self.assertEqual(sequence.mock_calls[0].args[0]["MGK Purchase Invoice"], {invoice.name})
		self.assertEqual(sequence.mock_calls[1][0], "invoice")
		frappe.db.set_value(
			receipt.doctype, receipt.name, "purchase_invoice", "another-invoice", update_modified=False
		)
		with self.assertRaisesRegex(frappe.ValidationError, "already billed"):
			invoice.submit()

	def test_cancel_order_pi_close_grn_dc_po(self):
		purchase = self.make_input()
		challan = self.make_challan()
		receipt = self.make_output([challan])
		invoice = self.make_invoice([receipt])
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		with self.assertRaises(frappe.ValidationError):
			receipt.cancel()
		with self.assertRaises(frappe.ValidationError):
			challan.cancel()
		order = frappe.get_doc("MGK Purchase Order", purchase.purchase_order)
		with self.assertRaises(frappe.ValidationError):
			order.cancel()
		invoice.cancel()
		with self.assertRaisesRegex(frappe.ValidationError, "reopen it before cancelling"):
			receipt.reload().cancel()
		close.cancel()
		run_adjustments(close.doctype, close.name)
		self.assertTrue(finish_reopen(close.name))
		receipt.reload().cancel()
		challan.reload().cancel()
		purchase.reload().cancel()
		order.reload().cancel()
		self.assertEqual(
			(receipt.docstatus, challan.docstatus, purchase.docstatus, order.docstatus), (2, 2, 2, 2)
		)
