from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

import frappe
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment import yrp_stock_valuation_adjustment as valuation

from mgk_yrp.job_work.dependencies import get_adjustment_blockers, get_downstream_blockers
from mgk_yrp.job_work.reopen import finish_reopen, validate_reopen
from mgk_yrp.job_work.reopen import get_adjustment_blockers as get_reopen_adjustment_blockers
from mgk_yrp.purchase.revaluation import lock_invoice_sources
from mgk_yrp.stock.dependencies import StockDependencies
from mgk_yrp.stock.locking import LOCK_ORDER
from mgk_yrp.tests.test_review_unit import throw_validation

DEPENDENCIES = "mgk_yrp.job_work.dependencies"
REOPEN = "mgk_yrp.job_work.reopen"
STOCK_DEPENDENCIES = "mgk_yrp.stock.dependencies"
REVALUATION = "mgk_yrp.purchase.revaluation"


class TestReopenDependencies(TestCase):
	"""Exercise transitive preflight without a site or database."""

	def setUp(self):
		self.database = Mock()
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", throw_validation))
		for module in (DEPENDENCIES, REOPEN, STOCK_DEPENDENCIES, REVALUATION):
			self.enterContext(patch(f"{module}._", side_effect=lambda value: value))
		self.close = SimpleNamespace(
			doctype="MGK Delivery Challan Close",
			name="upstream",
			stock_valuation_adjustment="own",
			outputs=[SimpleNamespace(output_receipt_sle="yarn")],
			items=[SimpleNamespace(consumption_sle="own-consumption", item="raw")],
			delivery_challan="own-challan",
			warehouse="supplier",
		)
		self.downstream = frappe._dict(
			docstatus=1, reopen_status="", stock_valuation_adjustment="downstream-sva"
		)
		self.database.get_value.side_effect = self.get_value
		self.buckets = self.enterContext(patch(f"{STOCK_DEPENDENCIES}.lock_stock_buckets"))
		self.outgoing = {
			"yarn": [self.entry("transfer-out", "transfer-in")],
			"transfer-in": [self.entry("consumption", voucher="downstream")],
			"dyed": [self.entry("next-out", "next-in")],
			"next-in": [self.entry("deep-consumption", voucher="deep-close")],
		}
		self.links = {"consumption": ["dyed"]}
		self.adjustments = []
		self.visited = []
		self.events = []
		self.database.sql.side_effect = self.query

	def get_value(self, doctype, name, fields, **kwargs):
		if fields == "delivery_challan":
			return f"challan-{name}"
		if fields == "reopen_status":
			return self.downstream.reopen_status
		return self.downstream

	def entry(self, name, paired=None, voucher=None):
		return frappe._dict(
			name=name,
			paired_stock_ledger_entry=paired,
			voucher_type=self.close.doctype if voucher else "MGK Delivery Challan",
			voucher_no=voucher or name,
		)

	def query(self, sql, parameters, **kwargs):
		if sql.startswith("SELECT name FROM `tabMGK"):
			self.events.append(("parent", sql, parameters))
			return []
		if "SELECT DISTINCT item, warehouse" in sql:
			return [("item", "warehouse")]
		if "voucher_type = 'MGK Goods Received Note'" in sql:
			return ["yarn"]
		if "tabMGK GRN Delivery Challan" in sql or sql.startswith("SELECT name FROM `tabYRP"):
			return []
		if "JOIN `tabYRP Stock Ledger Entry` outgoing" in sql:
			current = sql.rstrip().endswith("FOR UPDATE")
			self.events.append(("current" if current else "discover", sql, parameters))
			if current:
				self.visited.extend(parameters["receipts"])
			self.assertIn("outgoing.posting_datetime >= receipt.posting_datetime", sql)
			return [row for name in parameters["receipts"] for row in self.outgoing.get(name, [])]
		if "tabYRP Stock Valuation Production Link" in sql:
			return [name for outgoing in parameters["outgoing"] for name in self.links.get(outgoing, [])]
		self.assertIn("adjustment.name != %(own)s", sql)
		self.assertTrue(sql.rstrip().endswith("FOR UPDATE"))
		return [
			row
			for row in self.adjustments
			if row.target in parameters["nodes"]
			and (row.status != "Completed" or "adjustment.reversal_of" in sql)
		]

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
		for status in ("Queued", "Applying", "Apply Failed", "Reversal Queued"):
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

	def test_completed_shared_overlay_allows_reopen_but_consumption_owner_blocks(self):
		self.downstream.update(docstatus=2, reopen_status="Reopened")
		adjustment = frappe._dict(
			name="other-close-overlay",
			source_doctype=self.close.doctype,
			source_name="other-close",
			status="Completed",
			target="yarn",
		)
		self.adjustments = [adjustment]
		self.assertEqual(get_downstream_blockers(self.close), [])
		adjustment.target = "own-consumption"
		self.assertIn("other-close-overlay", get_adjustment_blockers(self.close, (adjustment.target,))[0])

	def test_downstream_close_and_its_adjustment_have_one_blocker(self):
		self.adjustments = [
			frappe._dict(
				name="downstream-sva",
				source_doctype=self.close.doctype,
				source_name="downstream",
				status="Reversal Queued",
				target="yarn",
			)
		]
		blockers = get_downstream_blockers(self.close)
		self.assertEqual(sum("Close downstream " in message for message in blockers), 1)
		self.assertFalse(any("downstream-sva" in message for message in blockers))

	def test_close_adjustment_blocker_says_reopen(self):
		self.adjustments = [
			frappe._dict(
				name="other-close-overlay",
				source_doctype=self.close.doctype,
				source_name="other-close",
				status="Completed",
				target="own-consumption",
			)
		]
		blockers = get_adjustment_blockers(self.close, ("own-consumption",))
		self.assertEqual(len(blockers), 1)
		self.assertIn("reopen its source Close", blockers[0])
		self.assertNotIn("cancel its source", blockers[0])

	def test_consumption_and_output_share_one_downstream_close_blocker(self):
		self.close.stock_valuation_adjustment = None
		self.adjustments = [
			frappe._dict(
				name="downstream-sva",
				source_doctype=self.close.doctype,
				source_name="downstream",
				status="Applying",
				target="own-consumption",
			)
		]
		blockers = get_reopen_adjustment_blockers(self.close)
		self.assertEqual(sum("Close downstream " in message for message in blockers), 1)
		self.assertFalse(any("downstream-sva" in message for message in blockers))
		self.downstream.update(docstatus=2, reopen_status="Reopened")
		blockers = get_reopen_adjustment_blockers(self.close)
		self.assertEqual(len(blockers), 1)
		self.assertIn("downstream-sva", blockers[0])

	def test_dependency_parents_then_buckets_then_current_ledger_reads(self):
		self.buckets.side_effect = lambda buckets: self.events.append(("buckets", buckets))
		get_downstream_blockers(self.close)
		phases = [event[0] for event in self.events]
		self.assertLess(
			max(i for i, phase in enumerate(phases) if phase == "discover"), phases.index("parent")
		)
		self.assertLess(
			max(i for i, phase in enumerate(phases) if phase == "parent"), phases.index("buckets")
		)
		self.assertLess(phases.index("buckets"), phases.index("current"))
		parents = [
			(event[1].split("`tab")[1].split("`")[0], event[2][0])
			for event in self.events
			if event[0] == "parent"
		]
		self.assertEqual(parents, sorted(parents, key=lambda row: (LOCK_ORDER.index(row[0]), row[1])))

	def test_graph_growth_after_parent_wait_requires_retry_without_new_parent_locks(self):
		def add_close(buckets):
			self.outgoing["yarn"].append(self.entry("new-consumption", voucher="new-close"))

		self.buckets.side_effect = add_close
		with self.assertRaisesRegex(frappe.ValidationError, "dependencies changed"):
			get_downstream_blockers(self.close)
		self.assertFalse(any(event[0] == "parent" and event[2] == ("new-close",) for event in self.events))

	def test_pi_submit_and_cancel_reject_reachable_reopening_close(self):
		self.downstream.update(docstatus=2, reopen_status="Reversing")
		for status in (1, 2):
			invoice = SimpleNamespace(doctype="MGK Purchase Invoice", name="PI", docstatus=status)
			with (
				self.subTest(docstatus=status),
				self.assertRaisesRegex(frappe.ValidationError, "Finish reopening"),
			):
				lock_invoice_sources(invoice, ["GRN"])
		self.downstream.reopen_status = "Reopened"
		lock_invoice_sources(invoice, ["GRN"])

	def test_pi_checks_current_reopen_state_after_waiting_for_locks(self):
		self.buckets.side_effect = lambda buckets: self.downstream.update(reopen_status="Reversing")
		invoice = SimpleNamespace(doctype="MGK Purchase Invoice", name="PI", docstatus=1)
		with self.assertRaisesRegex(frappe.ValidationError, "Finish reopening"):
			lock_invoice_sources(invoice, ["GRN"])
		self.assertTrue(self.database.get_value.call_args.kwargs["for_update"])

	def test_pi_revalidates_removed_consumption_after_finish_commits(self):
		def finish_during_wait(buckets):
			self.outgoing["transfer-in"] = []
			self.downstream.update(docstatus=2, reopen_status="Reopened")

		self.buckets.side_effect = finish_during_wait
		invoice = SimpleNamespace(doctype="MGK Purchase Invoice", name="PI", docstatus=1)
		lock_invoice_sources(invoice, ["GRN"])
		self.assertFalse(
			any(call.args[2] == "reopen_status" for call in self.database.get_value.call_args_list)
		)

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
		self.close.check_permission.assert_called_once_with("cancel")
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
