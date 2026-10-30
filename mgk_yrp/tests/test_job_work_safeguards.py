from collections import defaultdict
from copy import deepcopy
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call, patch

import frappe
from frappe.client import save
from frappe.model.document import Document
from yrp.yrp.doctype.yrp_item.yrp_item import get_or_create_variant
from yrp.yrp_stock.doctype.yrp_stock_entry.yrp_stock_entry import YRPStockEntry

from mgk_yrp import hooks
from mgk_yrp.job_work import dc_from_grn
from mgk_yrp.job_work.grn_from_dc import make_job_work_grn
from mgk_yrp.job_work.process_plan import PLAN_DOCTYPE, get_process_plan, save_process_plan
from mgk_yrp.job_work.reopen import finish_reopen
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import MGKDeliveryChallan
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.overrides.stock_entry import MGKStockEntry
from mgk_yrp.purchase.receipt import PurchaseReceipt
from mgk_yrp.stock.item_editor import get_item_details
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.stock.process_conversion import validate_process_conversions
from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import (
	close_dc,
	dimensioned_items,
	make_item,
	make_supplier,
	make_template_item,
	make_warehouse,
	run_adjustments,
	set_process_outputs,
)
from mgk_yrp.tests.fixtures import (
	make_job_work_grn as make_receipt,
)
from mgk_yrp.tests.test_grn_from_dc import add_attribute_value

DISPATCH = dc_from_grn.__name__
CHALLAN = MGKDeliveryChallan.__module__
RECEIPT = MGKGoodsReceivedNote.__module__
PURCHASE = "mgk_yrp.purchase.receipt"
CONVERSION = "mgk_yrp.stock.process_conversion"


def throw_validation(message, *args, **kwargs):
	raise frappe.ValidationError(message)


class TestJobWorkSafeguardsLocks(TestCase):
	def setUp(self):
		self.database = Mock()
		self.database.sql.return_value = []
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch("frappe.throw", throw_validation))
		for module in (DISPATCH, RECEIPT, CHALLAN, CONVERSION, PURCHASE):
			self.enterContext(patch(f"{module}._", side_effect=lambda text: text))

	def test_cancel_locks_downstream_before_frappe_receipt_lock(self):
		document = object.__new__(MGKGoodsReceivedNote)
		document.__dict__.update(doctype="MGK Goods Received Note", name="GRN", docstatus=2,
			purchase_order=None, delivery_challans=[])
		previous = SimpleNamespace(purchase_order=None, linked_delivery_challans=["DC-upstream"])
		sequence = Mock()
		with (
			patch.object(document, "is_new", return_value=False),
			patch("frappe.get_doc", return_value=previous),
			patch(f"{DISPATCH}.get_linking_challans", return_value=["DC-downstream"]),
			patch(f"{RECEIPT}.locking.lock_documents", sequence.parents),
			patch.object(Document, "load_doc_before_save", sequence.frappe),
		):
			document.load_doc_before_save()
		self.assertEqual(sequence.mock_calls, [call.parents({
			"MGK Delivery Challan": ["DC-upstream", "DC-downstream"],
			"MGK Goods Received Note": ["GRN"],
		}), call.frappe(raise_exception=False)])
		lock_documents(sequence.parents.call_args.args[0])
		self.assertEqual([arguments.args[1][0] for arguments in self.database.sql.call_args_list],
			["DC-downstream", "DC-upstream", "GRN"])

	def test_changed_downstream_requires_retry(self):
		document = SimpleNamespace(name="GRN", docstatus=2, purchase_order=None,
			linked_delivery_challans=[], get_doc_before_save=lambda: None)
		with (
			patch(f"{DISPATCH}.get_linking_challans", side_effect=[[], ["new-DC"]]),
			patch(f"{RECEIPT}.locking.lock_documents"),
			self.assertRaisesRegex(frappe.ValidationError, "Stock dependencies changed; retry the operation"),
		):
			MGKGoodsReceivedNote.lock_sources(document)

	def test_stock_entry_locks_parents_and_siblings_before_frappe(self):
		class ExtendedStockEntry(MGKStockEntry, YRPStockEntry):
			pass

		self.assertEqual(hooks.extend_doctype_class["YRP Stock Entry"],
			["mgk_yrp.overrides.stock_entry.MGKStockEntry"])
		entry = object.__new__(ExtendedStockEntry)
		entry.__dict__.update(doctype="YRP Stock Entry", name="MOVE-2", docstatus=2, mgk_delivery_challan="DC")
		previous = frappe._dict(mgk_delivery_challan="DC")
		self.database.get_value.return_value = "DC"
		sequence = Mock()
		with (
			patch.object(entry, "is_new", return_value=False),
			patch("frappe.get_doc", return_value=previous),
			patch(f"{DISPATCH}.get_head_office_moves", return_value=["MOVE-1", "MOVE-2"]),
			patch(f"{DISPATCH}.lock_documents", sequence.parents),
			patch.object(Document, "load_doc_before_save", sequence.frappe),
		):
			entry.load_doc_before_save()
		self.assertEqual(sequence.mock_calls, [call.parents({"MGK Delivery Challan": ["DC"],
			"YRP Stock Entry": ["MOVE-1", "MOVE-2", "MOVE-2"]}), call.frappe(raise_exception=False)])
		lock_documents({"YRP Stock Entry": ["MOVE-2", "MOVE-1"], "MGK Delivery Challan": ["DC"]})
		self.assertEqual([arguments.args[1][0] for arguments in self.database.sql.call_args_list],
			["DC", "MOVE-1", "MOVE-2"])

	def test_changed_move_set_requires_retry(self):
		entry = frappe._dict(doctype="YRP Stock Entry", name="MOVE", mgk_delivery_challan="DC")
		self.database.get_value.return_value = "DC"
		with (
			patch(f"{DISPATCH}.get_head_office_moves", side_effect=[["MOVE"], ["MOVE", "new-MOVE"]]),
			patch(f"{DISPATCH}.lock_documents"),
			self.assertRaisesRegex(frappe.ValidationError, "Stock dependencies changed; retry the operation"),
		):
			dc_from_grn.lock_head_office_move_sources(entry, entry)

	def test_surplus_and_orphan_moves_are_rejected(self):
		row = frappe._dict(item="Yarn", stock_qty=6, idx=1, goods_received_note_item="line")
		for rows in ([row], []):
			challan = SimpleNamespace(is_return=0, from_warehouse="HO", items=rows)
			with (
				self.subTest(rows=rows),
				patch(f"{DISPATCH}.get_moved_quantities", return_value=defaultdict(float, {("Source", "Yarn"): 10})),
				patch(f"{DISPATCH}.get_source_receipt", return_value=SimpleNamespace(warehouse="Source")),
				patch(f"{DISPATCH}.stock_key", return_value=("Source", "Yarn")),
				self.assertRaisesRegex(frappe.ValidationError, "must exactly match"),
			):
				dc_from_grn.validate_head_office_move(challan)

	def test_template_and_variant_outputs_share_one_key(self):
		for outputs in (("Template", "Variant-1"), ("Variant-1", "Variant-2")):
			rows = [frappe._dict(idx=index, process_name="Dyeing", item=item, from_qty=1, to_qty=1)
				for index, item in enumerate(outputs, 1)]
			document = frappe._dict(has_variants=1, stock_uom="Kg", mgk_process_conversions=rows)
			self.database.get_value.return_value = frappe._dict(stock_uom="Kg")
			with (
				self.subTest(outputs=outputs),
				patch(f"{CONVERSION}.get_parent_item", return_value="Template"),
				self.assertRaisesRegex(frappe.ValidationError, "Row 2: Process Dyeing to Item Template is already in row 1"),
			):
				validate_process_conversions(document)

	def test_aborted_purchase_transaction_preserves_original_error(self):
		for error in (frappe.QueryDeadlockError("deadlock"), RuntimeError("ordinary failure")):
			self.database.reset_mock()
			self.database.rollback.side_effect = (
				RuntimeError("SAVEPOINT does not exist") if isinstance(error, frappe.QueryDeadlockError) else None
			)
			self.database.is_deadlocked.return_value = False
			self.database.is_timedout.return_value = False
			order = Mock(doctype="MGK Purchase Order", docstatus=1, deliver_to_supplier=0, supplier="Supplier",
				items=[frappe._dict(item="Yarn", pending_qty=1)], flags=frappe._dict(),
				receipt_location={"location": "Owner", "warehouse": "Own"})
			order.name = "PO"
			flow = PurchaseReceipt(order)
			with (
				patch.object(flow, "check_permissions"),
				patch(f"{PURCHASE}.lock_documents"),
				patch(f"{PURCHASE}.lock_stock_buckets"),
				patch(f"{PURCHASE}.is_internal_route", return_value=False),
				patch("frappe.generate_hash", return_value="test"),
				patch.object(flow, "submit_documents", side_effect=error),
				self.assertRaises(type(error)) as raised,
			):
				flow.submit()
			self.assertIs(raised.exception, error)
			self.assertEqual(self.database.rollback.call_count, int(not isinstance(error, frappe.QueryDeadlockError)))
			self.database.commit.assert_not_called()


class TestJobWorkSafeguardsLifecycle(CloseTestCase):
	def plan_payload(self, rows):
		plan = frappe.get_doc({"doctype": PLAN_DOCTYPE, "items": dimensioned_items(rows)})
		return get_item_details(plan)

	def test_direct_document_submit_blocks_pending_upstream_reopen(self):
		challan, output = self.make_cycle()
		next_supplier = make_supplier()
		next_warehouse = make_warehouse(supplier=next_supplier)
		service = dc_from_grn.JobWorkDispatch([output], self.process_name, next_supplier, False)
		service.validate()
		draft = service.make_delivery_challan().insert()
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		close.reload().cancel()
		with self.assertRaisesRegex(frappe.ValidationError, "Finish reopening Close"):
			draft.submit()
		self.assertEqual(frappe.db.get_value(draft.doctype, draft.name, "docstatus"), 0)
		run_adjustments(close.doctype, close.name)
		self.assertTrue(finish_reopen(close.name))
		draft.reload().submit()
		self.assertEqual(draft.to_warehouse, next_warehouse)

	def test_submitted_api_cannot_clear_plan_pointer(self):
		self.make_input()
		challan = self.make_challan()
		payload = self.plan_payload([{"item": self.output_item, "qty": 10}])
		save_process_plan(challan.name, payload)
		challan.reload().mgk_process_planning = None
		with self.assertRaisesRegex(frappe.ValidationError, "maintained by Update Plan"):
			save(challan.as_json())
		self.assertEqual(challan.reload().mgk_process_planning, challan.name)
		self.assertTrue(frappe.db.exists(PLAN_DOCTYPE, challan.name))
		save_process_plan(challan.name, [])
		self.assertFalse(challan.reload().mgk_process_planning)
		self.assertFalse(frappe.db.exists(PLAN_DOCTYPE, challan.name))

	def test_submitted_moves_reject_draft_quantity_reduction(self):
		challan = self.make_draft_with_move()
		challan.items[0].qty = 6
		challan.save()
		with self.assertRaisesRegex(frappe.ValidationError, "must exactly match"):
			challan.submit()

	def test_submitted_moves_reject_removed_receipt_row(self):
		challan = self.make_draft_with_move()
		challan.items[0].goods_received_note = None
		challan.items[0].goods_received_note_item = None
		challan.save()
		with self.assertRaisesRegex(frappe.ValidationError, "must exactly match"):
			challan.submit()
		challan.set("items", [])
		with self.assertRaisesRegex(frappe.ValidationError, "must exactly match"):
			dc_from_grn.validate_head_office_move(challan)

	def make_draft_with_move(self):
		frappe.db.set_value("Supplier", {"mgk_is_head_office": 1}, "mgk_is_head_office", 0)
		frappe.get_doc("Supplier", self.owner).update({"mgk_is_head_office": 1}).save()
		warehouse = make_warehouse(supplier=make_supplier(is_company_location=1))
		receipt = make_receipt(supplier=self.supplier, warehouse=warehouse,
			items=[{"item": self.output_item, "qty": 10, "rate": 10}])
		service = dc_from_grn.JobWorkDispatch([receipt], self.process_name, self.supplier, True)
		service.lock_sources()
		service.validate()
		challan = service.make_delivery_challan().insert()
		service.move_stock(challan)
		return challan

	def test_worker_bucket_rejected_before_submit_and_other_route_closes(self):
		set_process_outputs(self.raw_item, self.process_name, [(self.raw_item, 1, 1)])
		self.make_input()
		challan = self.make_challan()
		receipt = make_job_work_grn(challan.name)
		receipt.items[0].qty = 50
		receipt.delivery_location, receipt.warehouse = self.supplier, self.destination
		message = "cannot be received into the job worker's warehouse"
		with self.assertRaisesRegex(frappe.ValidationError, message):
			receipt.insert()
		receipt.delivery_location = make_supplier(is_company_location=1)
		receipt.warehouse = make_warehouse(supplier=receipt.delivery_location)
		receipt.insert().submit()
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		self.assertEqual(self.get_overlay(receipt), 5000)
		close.reload().cancel()
		run_adjustments(close.doctype, close.name)
		self.assertTrue(finish_reopen(close.name))
		self.assertEqual(self.get_overlay(receipt), 0)

	def test_split_and_reorder_remain_distinct_across_two_saves(self):
		self.make_input()
		challan = self.make_challan()
		payload = self.plan_payload([
			{"item": self.output_item, "qty": 3, "row_index": "0"},
			{"item": self.output_item, "qty": 5, "row_index": "1"},
		])
		save_process_plan(challan.name, payload)
		groups = get_process_plan(challan.name)
		first, second = groups[0]["items"]
		split = deepcopy(first)
		split.pop("row_index", None)
		for cell in split["values"].values():
			if cell:
				cell.pop("name", None)
				cell["qty"] = 7
		groups[0]["items"] = [second, split, first]
		save_process_plan(challan.name, groups)
		self.assert_plan_lines(challan, [5, 7, 3])
		groups = get_process_plan(challan.name)
		groups[0]["items"].reverse()
		save_process_plan(challan.name, groups)
		self.assert_plan_lines(challan, [3, 7, 5])

	def test_real_conversion_rows_reject_shared_output_template(self):
		template, attributes = make_template_item()
		first = get_or_create_variant(template.name, attributes)
		add_attribute_value(template.attributes[0].as_dict(), "Second")
		second = get_or_create_variant(template.name, {next(iter(attributes)): "Second"})
		for outputs in ((template.name, first), (first, second)):
			with self.subTest(outputs=outputs):
				input_template = frappe.get_doc("Item", frappe.db.get_value("Item", self.raw_item, "variant_of"))
				input_template.set("mgk_process_conversions", [{
					"process_name": self.process_name, "item": output, "from_qty": 1, "to_qty": 1,
				} for output in outputs])
				with self.assertRaisesRegex(frappe.ValidationError, "Row 2: .* is already in row 1"):
					input_template.save()

	def assert_plan_lines(self, challan, quantities):
		plan = frappe.get_doc(PLAN_DOCTYPE, challan.name)
		self.assertEqual([row.qty for row in plan.items], quantities)
		self.assertEqual(len({row.row_index for row in plan.items}), len(quantities))
		self.assertEqual(len(get_process_plan(challan.name)[0]["items"]), len(quantities))
