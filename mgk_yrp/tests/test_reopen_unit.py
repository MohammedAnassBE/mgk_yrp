from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

import frappe
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment import yrp_stock_valuation_adjustment as valuation

from mgk_yrp.job_work.dependencies import get_downstream_blockers
from mgk_yrp.job_work.reopen import finish_reopen, validate_reopen
from mgk_yrp.tests.test_review_unit import throw_validation

DEPENDENCIES = "mgk_yrp.job_work.dependencies"
REOPEN = "mgk_yrp.job_work.reopen"


class TestReopenDependencies(TestCase):
	"""Exercise transitive preflight without a site or database."""

	def setUp(self):
		self.database = Mock()
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", throw_validation))
		for module in (DEPENDENCIES, REOPEN):
			self.enterContext(patch(f"{module}._", side_effect=lambda value: value))
		self.close = SimpleNamespace(
			doctype="MGK Delivery Challan Close",
			name="upstream",
			stock_valuation_adjustment="own",
			outputs=[SimpleNamespace(output_receipt_sle="yarn")],
		)
		self.downstream = frappe._dict(
			docstatus=1, reopen_status="", stock_valuation_adjustment="downstream-sva"
		)
		self.database.get_value.return_value = self.downstream
		self.outgoing = {
			"yarn": [self.entry("transfer-out", "transfer-in")],
			"transfer-in": [self.entry("consumption", voucher="downstream")],
			"dyed": [self.entry("next-out", "next-in")],
			"next-in": [self.entry("deep-consumption", voucher="deep-close")],
		}
		self.links = {"consumption": ["dyed"]}
		self.adjustments = []
		self.visited = []
		self.database.sql.side_effect = self.query

	def entry(self, name, paired=None, voucher=None):
		return frappe._dict(
			name=name,
			paired_stock_ledger_entry=paired,
			voucher_type=self.close.doctype if voucher else "MGK Delivery Challan",
			voucher_no=voucher or name,
		)

	def query(self, sql, parameters, **kwargs):
		self.assertTrue(sql.rstrip().endswith("FOR UPDATE"))
		if "JOIN `tabYRP Stock Ledger Entry` outgoing" in sql:
			self.visited.extend(parameters["receipts"])
			self.assertIn("outgoing.posting_datetime >= receipt.posting_datetime", sql)
			return [row for name in parameters["receipts"] for row in self.outgoing.get(name, [])]
		if "tabYRP Stock Valuation Production Link" in sql:
			return [name for outgoing in parameters["outgoing"] for name in self.links.get(outgoing, [])]
		self.assertIn("adjustment.name != %(own)s", sql)
		self.assertIn("adjustment.reversal_of", sql)
		return [row for row in self.adjustments if row.target in parameters["nodes"]]

	def test_completed_downstream_close_must_be_reversed_first(self):
		blockers = get_downstream_blockers(self.close)
		self.assertTrue(any("downstream" in message for message in blockers))
		self.assertTrue(any("deep-close" in message for message in blockers))
		self.assertEqual(set(self.visited), {"yarn", "transfer-in", "dyed", "next-in"})
		self.assertTrue(self.database.get_value.call_args.kwargs["for_update"])

	def test_downstream_reversal_completed_before_finish_still_blocks(self):
		self.downstream.update(docstatus=2, reopen_status="Reversing")
		blockers = get_downstream_blockers(self.close)
		self.assertTrue(any("downstream" in message for message in blockers))
		self.downstream.reopen_status = "Reopened"
		self.assertEqual(get_downstream_blockers(self.close), [])

	def test_deep_adjustment_blocker_names_invoice_and_sva(self):
		self.downstream.update(docstatus=2, reopen_status="Reopened")
		for status in ("Queued", "Applying", "Apply Failed", "Completed", "Reversal Queued"):
			with self.subTest(status=status):
				self.adjustments = [
					frappe._dict(
						name="SVA-43",
						source_doctype="MGK Purchase Invoice",
						source_name="PI-43",
						status=status,
						target="deep-consumption",
					)
				]
				blockers = get_downstream_blockers(self.close)
				self.assertEqual(len(blockers), 1)
				self.assertIn("SVA-43", blockers[0])
				self.assertIn("MGK Purchase Invoice PI-43", blockers[0])
				self.assertIn(status, blockers[0])

	def test_transfer_production_cycle_terminates(self):
		self.links["deep-consumption"] = ["yarn"]
		get_downstream_blockers(self.close)
		self.assertEqual(len(self.visited), 4)

	def test_no_output_does_not_query_dependencies(self):
		self.close.outputs = []
		self.assertEqual(get_downstream_blockers(self.close), [])
		self.database.sql.assert_not_called()

	def test_preflight_rejects_before_creating_reversal(self):
		with (
			patch(f"{REOPEN}.lock_reopen"),
			patch(f"{REOPEN}.get_reopen_blockers", side_effect=lambda close: get_downstream_blockers(close)),
		):
			with self.assertRaisesRegex(frappe.ValidationError, "downstream"):
				validate_reopen(self.close)
		self.database.set_value.assert_not_called()

	def test_finish_failed_reversal_keeps_consumption_and_links_for_retry(self):
		self.close.docstatus, self.close.reopen_status = 2, "Reversing"
		self.close.check_permission, self.close.reload = Mock(), Mock()
		self.close.flags = frappe._dict()
		with (
			patch(f"{REOPEN}.frappe.get_doc", return_value=self.close),
			patch(f"{REOPEN}.lock_reopen"),
			patch(f"{REOPEN}.frappe.get_all", return_value=["Apply Failed"]),
			patch(f"{REOPEN}.complete_reopen") as complete,
		):
			self.assertFalse(finish_reopen(self.close.name))
			complete.assert_not_called()
		self.assertEqual(self.close.reopen_status, "Reversing")
		self.database.set_value.assert_not_called()


class TestValuationRetry(TestCase):
	def test_yrp_retry_resumes_pending_entries_without_reapplying_committed_entries(self):
		database = Mock()
		doc = frappe._dict(
			name="reversal",
			docstatus=1,
			status="Applying",
			total_entries=3,
			reversal_of=None,
			check_permission=Mock(),
		)
		entries = {"first": "Pending", "second": "Pending", "third": "Pending"}
		applied = []

		def apply_entry(name):
			if name == "second" and len(applied) == 1:
				raise frappe.ValidationError("transient failure")
			entries[name] = "Applied"
			applied.append(name)

		def set_values(name, **values):
			doc.update(values)

		with (
			patch("frappe.db", database, create=True),
			patch("frappe.conf", frappe._dict()),
			patch.object(valuation, "now_datetime", return_value="now"),
			patch.object(valuation, "_lock_adjustment", return_value=doc),
			patch.object(valuation, "_set_adjustment_values", side_effect=set_values),
			patch.object(valuation, "_build_initial_entries") as build,
			patch.object(valuation, "_apply_propagation_entry", side_effect=apply_entry) as apply,
			patch.object(valuation, "_refresh_progress"),
			patch.object(valuation, "_complete_adjustment", return_value=True),
			patch.object(valuation, "enqueue_adjustment") as enqueue,
			patch.object(valuation, "_mark_failed") as failed,
			patch.object(valuation.frappe, "get_doc", return_value=doc),
		):
			database.get_value.side_effect = lambda *args, **kwargs: next(
				(name for name, status in entries.items() if status == "Pending"), None
			)
			database.count.side_effect = lambda *args: sum(status == "Pending" for status in entries.values())
			with self.assertRaisesRegex(frappe.ValidationError, "transient failure"):
				valuation.process_adjustment(doc.name)
			self.assertEqual(applied, ["first"])
			database.rollback.assert_called_once()
			self.assertEqual(failed.call_args.args[:2], (doc.name, "Apply"))
			doc.status = "Apply Failed"
			self.assertEqual(valuation.retry_adjustment(doc.name), doc.name)
			enqueue.assert_called_once_with(doc.name, retry=True)
			self.assertEqual(doc.total_entries, 3)
			apply.side_effect = lambda name: (entries.update({name: "Applied"}), applied.append(name))
			valuation.process_adjustment(doc.name)
			self.assertEqual(applied, ["first", "second", "third"])
			build.assert_not_called()
