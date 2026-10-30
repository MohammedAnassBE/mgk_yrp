from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

import frappe

from mgk_yrp.job_work.close_valuation import (
	build_allocations_and_links,
	get_dc_item_values,
	get_linked_outputs,
	validate_outputs,
)
from mgk_yrp.job_work.reopen import finish_reopen
from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan_close.mgk_delivery_challan_close import (
	MGKDeliveryChallanClose,
)
from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import (
	close_dc,
	make_conversion_input,
	make_item,
	make_purchase_invoice,
	make_received_type,
	make_uom,
	run_adjustments,
)

VALUATION = "mgk_yrp.job_work.close_valuation"
REVALUATION = "mgk_yrp.purchase.revaluation"


def make_challan(name="DC", items=("30s",)):
	return SimpleNamespace(
		name=name,
		doctype="MGK Delivery Challan",
		process_name="Doubling",
		items=[frappe._dict(name=f"{name}-{item}", item=item, stock_uom="Kg") for item in items],
		from_warehouse="Main",
		to_warehouse="Supplier",
		check_permission=Mock(),
	)


def make_output(item="60s Cone", quantity=20, **values):
	return frappe._dict(
		{
			"name": item, "idx": 1, "item": item, "stock_qty": quantity, "stock_uom": "Cone",
			"output_receipt_sle": f"receipt-{item}", "warehouse": "Other", **values,
		}
	)


class TestCloseAllocation(TestCase):
	def setUp(self):
		self.challan = make_challan()
		self.receipt = SimpleNamespace(
			name="GRN", doctype="MGK Goods Received Note", warehouse="Other",
			delivery_challans=[frappe._dict(delivery_challan="DC")], check_permission=Mock(),
			items=[make_output(), make_output("Waste", 10, stock_uom="Kg")],
		)
		self.conversions = {"30s": [self.conversion("60s Cone", 1, 2), self.conversion("Waste")]}
		self.templates = {}
		self.attributes = {}
		self.database = Mock()
		self.database.get_value.return_value = 10
		self.enterContext(patch("frappe.db", self.database, create=True))
		self.enterContext(patch(f"{VALUATION}._", side_effect=lambda message: message))
		self.enterContext(patch("frappe.throw", side_effect=self.throw))
		self.enterContext(patch(
			f"{VALUATION}.get_parent_item", side_effect=lambda item: self.templates.get(item, item)
		))
		self.convert = self.enterContext(patch(
			f"{VALUATION}.get_process_conversion", side_effect=lambda item, process: self.conversions.get(item, [])
		))
		self.enterContext(patch(
			"frappe.get_all", side_effect=lambda *args, **values: self.attributes.get(values["filters"]["parent"], [])
		))
		self.documents = {"DC": self.challan, "GRN": self.receipt}
		self.enterContext(patch("frappe.get_doc", side_effect=lambda doctype, name, **values: self.documents[name]))
		self.enterContext(patch(f"{VALUATION}.get_linking_grns", return_value=["GRN"]))
		self.enterContext(patch(f"{VALUATION}.get_active_receipt", return_value=frappe._dict(name="ledger", rate=10)))

	@staticmethod
	def throw(message):
		raise frappe.ValidationError(message)

	@staticmethod
	def conversion(item, from_qty=1, to_qty=1):
		return frappe._dict(item=item, from_qty=from_qty, to_qty=to_qty)

	def get_close(self, outputs=None, items=None):
		inputs = [frappe._dict(
			name="input", item="30s", own_value=2000, remaining_stock_qty=20, consumption_sle="consumption"
		)] if items is None else items
		return SimpleNamespace(items=inputs, outputs=get_linked_outputs("DC") if outputs is None else outputs)

	def test_mixed_uom_weights_allocate_input_value_and_quantity(self):
		close = self.get_close()
		allocations, links = build_allocations_and_links(close)
		self.assertEqual([row.input_item for row in close.outputs], ["30s", "30s"])
		self.assertEqual([row.allocation_weight for row in close.outputs], [10, 10])
		self.assertEqual([row.allocated_value for row in close.outputs], [1000, 1000])
		self.assertEqual([row.allocated_rate for row in close.outputs], [50, 100])
		self.assertEqual([row["input_quantity"] for row in links], [10, 10])
		self.assertEqual([row["allocation_weight"] for row in allocations], [10, 10])
		self.assertEqual([row["allocation_weight"] for row in links], [10, 10])
		validate_outputs(self.challan, close.outputs)

	def test_same_uom_also_uses_conversion_weights(self):
		self.receipt.items[0].stock_uom = "Kg"
		close = self.get_close()
		build_allocations_and_links(close)
		self.assertEqual([row.allocation_weight for row in close.outputs], [10, 10])
		self.assertEqual([row.allocated_value for row in close.outputs], [1000, 1000])

	def test_allocation_conserves_rounding_per_input(self):
		self.conversions["30s"] = [self.conversion("60s Cone")]
		self.receipt.items = [make_output(quantity=1, name=f"row-{index}") for index in range(3)]
		close = self.get_close()
		close.items[0].update(own_value=1, remaining_stock_qty=1)
		allocations, links = build_allocations_and_links(close)
		self.assertEqual([row.allocated_value for row in close.outputs], [0.333333, 0.333333, 0.333334])
		self.assertEqual(sum(row["difference"] for row in allocations), 1)
		self.assertEqual(sum(row["input_quantity"] for row in links), 1)

	def test_same_uom_rejected_rows_receive_their_share(self):
		self.conversions["30s"][0] = self.conversion("60s Cone")
		self.receipt.items = [
			make_output(quantity=40, stock_uom="Kg", received_type="Rejected"),
			make_output("Waste", 10, stock_uom="Kg"),
		]
		close = self.get_close()
		close.items[0].update(own_value=5000, remaining_stock_qty=50)
		build_allocations_and_links(close)
		self.assertEqual([row.allocated_value for row in close.outputs], [4000, 1000])
		self.assertEqual([row.allocated_rate for row in close.outputs], [100, 100])

	def test_two_inputs_allocate_only_to_their_outputs(self):
		self.challan = self.documents["DC"] = make_challan(items=("30s", "40s"))
		self.conversions["40s"] = [self.conversion("80s Cone", 2, 5)]
		self.receipt.items.append(make_output("80s Cone", 25))
		close = self.get_close()
		close.items.append(frappe._dict(
			name="second", item="40s", own_value=3000, remaining_stock_qty=10, consumption_sle="second"
		))
		allocations, links = build_allocations_and_links(close)
		self.assertEqual([row.allocated_value for row in close.outputs], [1000, 1000, 3000])
		self.assertEqual([row["source_sle"] for row in allocations], ["consumption", "consumption", "second"])
		self.assertEqual([row["input_quantity"] for row in links], [10, 10, 10])

	def test_duplicate_input_rows_share_outputs_without_ambiguity(self):
		self.challan.items.append(self.challan.items[0].copy())
		close = self.get_close()
		close.items.append(frappe._dict(
			name="second", item="30s", own_value=1000, remaining_stock_qty=10, consumption_sle="second"
		))
		_, links = build_allocations_and_links(close)
		self.assertEqual([row.allocated_value for row in close.outputs], [1500, 1500])
		self.assertEqual(len(links), 4)

	def test_ambiguous_output_throws_exact_message(self):
		self.challan.items.append(frappe._dict(item="40s"))
		self.conversions["40s"] = self.conversions["30s"]
		with self.assertRaisesRegex(frappe.ValidationError, r"^Row 1 of GRN: 60s Cone cannot be traced to one item of Delivery Challan DC\.$"):
			get_linked_outputs("DC")

	def test_shared_attribute_values_narrow_variants(self):
		self.challan.items = [frappe._dict(item=item) for item in ("30s-red", "30s-blue")]
		self.templates = {"30s-red": "30s", "30s-blue": "30s", "60s-red": "60s Cone"}
		self.conversions["30s-red"] = self.conversions["30s"]
		self.attributes = {
			item: [frappe._dict(attribute="Colour", attribute_value=colour)]
			for item, colour in (("30s-red", "red"), ("30s-blue", "blue"), ("60s-red", "red"))
		}
		self.receipt.items = [make_output("60s-red")]
		self.assertEqual(get_linked_outputs("DC")[0].input_item, "30s-red")

	def test_every_shared_attribute_must_agree_when_narrowing(self):
		self.challan.items.append(frappe._dict(item="40s"))
		self.conversions["40s"] = self.conversions["30s"]
		for item in ("30s", "40s", "60s Cone"):
			self.attributes[item] = [frappe._dict(attribute="Colour", attribute_value="Red")]
		self.attributes["30s"].append(frappe._dict(attribute="Count", attribute_value="30"))
		self.attributes["40s"].append(frappe._dict(attribute="Count", attribute_value="40"))
		self.attributes["60s Cone"].append(frappe._dict(attribute="Count", attribute_value="40"))
		self.receipt.items = self.receipt.items[:1]
		self.assertEqual(get_linked_outputs("DC")[0].input_item, "40s")

	def test_single_template_candidate_ignores_attribute_difference(self):
		self.attributes = {
			item: [frappe._dict(attribute="Colour", attribute_value=colour)]
			for item, colour in (("30s", "red"), ("60s Cone", "blue"))
		}
		self.assertEqual(get_linked_outputs("DC")[0].input_item, "30s")

	def test_unmapped_template_throws_for_same_and_mixed_uoms(self):
		self.conversions.clear()
		for unit in ("Kg", "Cone"):
			with self.subTest(stock_uom=unit):
				self.receipt.items = [make_output(stock_uom=unit)]
				with self.assertRaisesRegex(frappe.ValidationError, "cannot be traced to one item"):
					get_linked_outputs("DC")

	def test_same_template_without_conversion_uses_stock_quantity(self):
		self.conversions.clear()
		self.templates["30s-blue"] = "30s"
		self.receipt.items = [make_output("30s-blue", 17, stock_uom="Kg")]
		self.assertEqual(get_linked_outputs("DC")[0].allocation_weight, 17)

	def test_existing_conversion_disables_same_template_fallback(self):
		self.receipt.items = [make_output("30s", 10, stock_uom="Kg")]
		with self.assertRaisesRegex(frappe.ValidationError, "cannot be traced to one item"):
			get_linked_outputs("DC")

	def test_same_template_conversion_applies_its_ratio(self):
		self.conversions["30s"] = [self.conversion("30s", 3, 2)]
		self.receipt.items = [make_output("30s", 10, stock_uom="Kg")]
		self.assertEqual(get_linked_outputs("DC")[0].allocation_weight, 15)

	def test_multi_dc_rows_exclusive_to_other_dc_are_skipped(self):
		self.documents["OTHER"] = make_challan("OTHER", ("40s",))
		self.conversions["40s"] = [self.conversion("80s Cone")]
		self.receipt.delivery_challans.append(frappe._dict(delivery_challan="OTHER"))
		self.receipt.items.append(make_output("80s Cone"))
		self.assertEqual([row.item for row in get_linked_outputs("DC")], ["60s Cone", "Waste"])
		self.documents["OTHER"].check_permission.assert_called_once_with("read")

	def test_multi_dc_row_unmapped_by_all_dcs_throws(self):
		self.documents["OTHER"] = make_challan("OTHER", ("40s",))
		self.receipt.delivery_challans.append(frappe._dict(delivery_challan="OTHER"))
		self.receipt.items.append(make_output("Unknown"))
		with self.assertRaisesRegex(frappe.ValidationError, "Unknown cannot be traced"):
			get_linked_outputs("DC")

	def test_zero_rows_are_not_traced(self):
		self.receipt.items.append(make_output("Unknown", 0))
		self.assertEqual(len(get_linked_outputs("DC")), 2)

	def test_invalid_conversion_quantity_fails_loudly(self):
		for field in ("from_qty", "to_qty"):
			with self.subTest(field=field):
				self.conversions["30s"][0] = self.conversion("60s Cone")
				self.conversions["30s"][0][field] = 0
				with self.assertRaisesRegex(frappe.ValidationError, "greater than zero"):
					get_linked_outputs("DC")

	def test_snapshot_allocation_ignores_later_conversion_changes(self):
		close = self.get_close()
		self.convert.side_effect = AssertionError("Submitted allocation must use snapshots")
		build_allocations_and_links(close)
		self.assertEqual([row.allocation_weight for row in close.outputs], [10, 10])
		self.assertEqual([row.allocated_value for row in close.outputs], [1000, 1000])

	def test_input_without_outputs_is_loss_and_has_no_links(self):
		close = self.get_close()
		close.items.append(frappe._dict(
			name="lost", item="40s", own_value=3000, remaining_stock_qty=10, consumption_sle="lost"
		))
		MGKDeliveryChallanClose.set_preview_totals(close)
		allocations, links = build_allocations_and_links(close)
		self.assertEqual((close.loss_value, close.total_dc_value), (3000, 5000))
		self.assertEqual(len(links), 2)
		self.assertEqual(sum(row["difference"] for row in allocations), 2000)
		self.assertIsNone(close.output_stock_uom)
		self.assertEqual(close.value_per_unit, 0)

	def test_no_outputs_consumes_all_value_as_loss(self):
		close = self.get_close(outputs=[])
		MGKDeliveryChallanClose.set_preview_totals(close)
		self.assertEqual((close.loss_value, close.total_dc_value), (2000, 2000))
		self.assertEqual(build_allocations_and_links(close), ([], []))

	def test_net_return_value_is_per_input_row(self):
		self.challan.items.append(frappe._dict(name="DC-40s", item="40s", stock_uom="Kg"))
		self.challan.get_returned_stock_qty = Mock(return_value={"DC-30s": 5, "DC-40s": 0})
		ledgers = [
			frappe._dict(name="incoming", qty=20, rate=100, valuation_adjustment_value=0),
			frappe._dict(name="second", qty=10, rate=300, valuation_adjustment_value=0),
		]
		with patch(f"{VALUATION}.get_active_receipt", side_effect=ledgers):
			rows = get_dc_item_values(self.challan)
		self.assertEqual([(row.own_value, row.remaining_stock_qty) for row in rows], [(1500, 15), (3000, 10)])

	def test_cyclic_route_still_throws(self):
		with self.assertRaisesRegex(frappe.ValidationError, "Cyclic route"):
			validate_outputs(self.challan, [make_output("30s", warehouse="Main")])


class TestCloseAllocationIntegration(CloseTestCase):
	def setUp(self):
		super().setUp()
		self.waste = make_item(stock_uom=make_uom("Kg"))
		self.template, self.raw_item = make_conversion_input(
			self.process_name, [(self.output_item, 1, 1), (self.waste, 1, 1)]
		)
		self.enterContext(patch(f"{REVALUATION}.is_stock_adjustment_enabled", return_value=True))

	def make_split_output(self, challans, quantity=40, received_type=None):
		return self.make_output(challans, items=[
			{"item": self.output_item, "qty": quantity, "rate": 10, "received_type": received_type or make_received_type()},
			{"item": self.waste, "qty": 10, "rate": 0},
		])

	def get_receipt_values(self, receipt):
		return {
			row.item: row.qty * row.rate + row.valuation_adjustment_value
			for row in get_voucher_sles(receipt.doctype, receipt.name)
		}

	def test_j20_same_uom_100_per_unit_and_rejected_share(self):
		self.make_input()
		challan = self.make_challan()
		receipt = self.make_split_output([challan], received_type=make_received_type("Rejected"))
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		self.assertEqual(close.value_per_unit, 100)
		self.assertEqual(self.get_receipt_values(receipt), {self.output_item: 4400, self.waste: 1000})
		self.assertEqual([row.allocated_value for row in close.reload().outputs], [4000, 1000])

	def test_j20_invoice_is_additive_before_and_after_close(self):
		for invoice_first in (True, False):
			with self.subTest(invoice_first=invoice_first):
				self.make_input()
				challan = self.make_challan()
				receipt = self.make_split_output([challan])
				if not invoice_first:
					close = close_dc(challan)
					run_adjustments(close.doctype, close.name)
				invoice = make_purchase_invoice(
					against="Job Work", supplier=self.supplier, grns=[receipt],
					rates={receipt.items[0].name: 12},
				)
				run_adjustments(invoice.doctype, invoice.name)
				if invoice_first:
					close = close_dc(challan)
					run_adjustments(close.doctype, close.name)
				self.assertEqual(self.get_receipt_values(receipt), {self.output_item: 4480, self.waste: 1000})

	def test_j20_shared_input_two_dc_receipt_gets_both_values(self):
		self.make_input(quantity=100)
		challans = [self.make_challan(), self.make_challan()]
		receipt = self.make_split_output(challans)
		for challan in challans:
			close = close_dc(challan)
			run_adjustments(close.doctype, close.name)
		self.assertEqual(self.get_receipt_values(receipt), {self.output_item: 8400, self.waste: 2000})

	def test_j21_two_inputs_only_value_their_own_outputs(self):
		second_output = make_item(stock_uom=make_uom("Cone"))
		_, second_input = make_conversion_input(self.process_name, [(second_output, 1, 2)])
		self.make_input(quantity=20)
		self.make_input(quantity=10, rate=300, item=second_input)
		challan = self.make_challan(items=[
			{"item": self.raw_item, "qty": 20}, {"item": second_input, "qty": 10},
		])
		receipt = self.make_output([challan], items=[
			{"item": self.output_item, "qty": 20, "rate": 10},
			{"item": second_output, "qty": 20, "rate": 10},
		])
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		self.assertEqual([row.allocated_value for row in close.reload().outputs], [2000, 3000])
		self.assertEqual([row.input_item for row in close.outputs], [self.raw_item, second_input])
		self.assertEqual(len(self.get_links(close)), 2)
		self.assertEqual(self.get_receipt_values(receipt), {self.output_item: 2200, second_output: 3200})

	def test_j20_disjoint_inputs_in_two_dc_receipt_skip_other_outputs(self):
		second_output = make_item(stock_uom=make_uom("Kg"))
		_, second_input = make_conversion_input(self.process_name, [(second_output, 1, 1)])
		self.make_input()
		self.make_input(rate=200, item=second_input)
		first = self.make_challan()
		second = self.make_challan(items=[{"item": second_input, "qty": 50}])
		receipt = self.make_output([first, second], items=[
			{"item": self.output_item, "qty": 50, "rate": 10},
			{"item": second_output, "qty": 50, "rate": 10},
		])
		for challan, item, value in ((first, self.output_item, 5000), (second, second_output, 10000)):
			close = close_dc(challan)
			run_adjustments(close.doctype, close.name)
			self.assertEqual([(row.item, row.allocated_value) for row in close.reload().outputs], [(item, value)])
		self.assertEqual(self.get_receipt_values(receipt), {self.output_item: 5500, second_output: 10500})

	def test_j21_mixed_uom_snapshot_survives_ratio_edit_and_reopen(self):
		cone = make_item(stock_uom=make_uom("Cone"))
		conversion = self.template.mgk_process_conversions[0]
		conversion.item, conversion.to_qty = cone, 2
		self.template.save(ignore_permissions=True)
		self.make_input(quantity=20)
		challan = self.make_challan(quantity=20)
		receipt = self.make_output([challan], items=[
			{"item": cone, "qty": 20, "rate": 10}, {"item": self.waste, "qty": 10, "rate": 0},
		])
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		self.template.reload()
		self.template.mgk_process_conversions[0].to_qty = 4
		self.template.save(ignore_permissions=True)
		close.reload()
		self.assertEqual([row.allocation_weight for row in close.outputs], [10, 10])
		self.assertEqual([row.input_item for row in close.outputs], [self.raw_item, self.raw_item])
		self.assertEqual([row.allocated_value for row in close.outputs], [1000, 1000])
		self.assertEqual([link.allocation_weight for link in self.get_links(close)], [10, 10])
		close.cancel()
		run_adjustments(close.doctype, close.name)
		self.assertTrue(finish_reopen(close.name))
		self.assertEqual(self.get_receipt_values(receipt), {cone: 200, self.waste: 0})
		self.assertEqual([row.allocation_weight for row in close.reload().outputs], [10, 10])
		self.assertFalse(self.get_links(close))
