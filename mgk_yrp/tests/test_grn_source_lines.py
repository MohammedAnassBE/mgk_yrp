from copy import deepcopy

import frappe
from yrp.yrp.doctype.yrp_item.yrp_item import get_or_create_variant

from mgk_yrp.job_work.grn_from_dc import get_converted_outputs, get_planned_outputs, make_job_work_grn
from mgk_yrp.job_work.process_plan import save_process_plan
from mgk_yrp.stock.dimensions import get_dimension_defaults
from mgk_yrp.stock.item_editor import get_cells, get_item_details
from mgk_yrp.stock.ledger import get_voucher_sles
from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import (
	close_dc,
	make_item,
	make_item_attribute,
	make_warehouse,
	run_adjustments,
	set_process_outputs,
)
from mgk_yrp.tests.test_grn_from_dc import add_attribute_value, make_template


class TestGrnSourceLines(CloseTestCase):
	def setUp(self):
		super().setUp()
		size, size_value = make_item_attribute()
		self.colour, _ = make_item_attribute()
		for value in ("Raw", "Red", "Blue"):
			add_attribute_value(self.colour, value)
		self.yarn = make_template([size, self.colour], size["attribute"])
		self.variants = {
			colour: get_or_create_variant(self.yarn.name, {
				size["attribute"]: size_value, self.colour["attribute"]: colour,
			})
			for colour in ("Raw", "Red", "Blue")
		}
		set_process_outputs(self.yarn.name, self.process_name, [(self.yarn.name, 1, 1)])
		self.receiving = make_warehouse(supplier=self.owner)

	def make_dyeing_challan(self):
		for colour, rate in (("Raw", 100), ("Red", 300)):
			self.make_input(quantity=10, rate=rate, item=self.variants[colour])
		return self.make_challan(items=[
			{"item": self.variants[colour], "qty": 10} for colour in ("Raw", "Red")
		])

	def mapped_receipt(self, challans):
		receipt = make_job_work_grn([challan.name for challan in challans])
		receipt.warehouse = self.receiving
		for row in receipt.items:
			row.qty, row.rate = 10, 0
		return receipt

	def save_editor(self, receipt, groups):
		receipt.item_details = frappe.as_json(groups)
		receipt.set("items", [])
		return receipt.save(ignore_permissions=True)

	def test_recoloured_prefill_saves_and_close_values_follow_source_items(self):
		challan = self.make_dyeing_challan()
		receipt = self.mapped_receipt([challan])
		groups = get_item_details(receipt)
		groups[0]["items"][0]["attributes"][self.colour["attribute"]] = "Blue"
		self.save_editor(receipt, groups)
		receipt.submit()
		self.assertEqual(receipt.items[0].item, self.variants["Blue"])
		self.assertEqual(receipt.items[0].delivery_challan_item, challan.items[0].name)
		close = close_dc(challan)
		run_adjustments(close.doctype, close.name)
		self.assertEqual(
			[(row.item, row.input_item, row.allocated_value) for row in close.reload().outputs],
			[(self.variants["Blue"], self.variants["Raw"], 1000),
			 (self.variants["Red"], self.variants["Red"], 3000)],
		)
		values = {row.item: row.valuation_adjustment_value for row in get_voucher_sles(receipt.doctype, receipt.name)}
		self.assertEqual(values, {self.variants["Blue"]: 1000, self.variants["Red"]: 3000})

	def test_manual_blue_row_fails_at_draft_save_with_close_trace_message(self):
		challan = self.make_dyeing_challan()
		receipt = self.mapped_receipt([challan]).insert(ignore_permissions=True)
		receipt.append("items", {"item": self.variants["Blue"], "qty": 1, "rate": 0})
		message = f"Row 3 of {receipt.name}: {self.variants['Blue']} cannot be traced to one item of Delivery Challan {challan.name}."
		with self.assertRaisesRegex(frappe.ValidationError, "cannot be traced to one item") as error:
			receipt.save(ignore_permissions=True)
		self.assertEqual(str(error.exception), message)

	def test_ambiguous_zero_prefill_also_fails_at_save(self):
		challan = self.make_dyeing_challan()
		receipt = self.mapped_receipt([challan])
		receipt.items[0].update({"item": self.variants["Blue"], "qty": 0, "delivery_challan_item": None})
		with self.assertRaisesRegex(frappe.ValidationError, "cannot be traced to one item"):
			receipt.insert(ignore_permissions=True)

	def test_split_and_two_editor_round_trips_preserve_source_link(self):
		challan = self.make_dyeing_challan()
		receipt = self.mapped_receipt([challan]).insert(ignore_permissions=True)
		groups = get_item_details(receipt)
		entry = groups[0]["items"][0]
		split = deepcopy(entry)
		split.pop("row_index", None)
		split["attributes"][self.colour["attribute"]] = "Blue"
		for cell in entry["values"].values():
			cell["qty"] = 6
		for cell in split["values"].values():
			cell.pop("name", None)
			cell.update(qty=4, is_prefilled=1)
		groups[0]["items"].insert(1, split)
		self.save_editor(receipt, groups)
		self.save_editor(receipt, get_item_details(receipt.reload()))
		self.assertEqual([row.item for row in receipt.reload().items], [
			self.variants[colour] for colour in ("Raw", "Blue", "Red")
		])
		self.assertEqual([row.qty for row in receipt.items], [6, 4, 10])
		self.assertEqual([row.delivery_challan_item for row in receipt.items], [
			challan.items[0].name, challan.items[0].name, challan.items[1].name,
		])
		self.assertEqual(len({row.name for row in receipt.items}), 3)

	def test_forged_source_from_unlinked_challan_throws(self):
		first, other = self.make_dyeing_challan(), self.make_dyeing_challan()
		receipt = self.mapped_receipt([first])
		receipt.items[0].delivery_challan_item = other.items[0].name
		with self.assertRaisesRegex(frappe.ValidationError, "not on the linked Delivery Challans") as error:
			receipt.insert(ignore_permissions=True)
		self.assertEqual(str(error.exception),
			f"Row 1: its Delivery Challan line {other.items[0].name} is not on the linked Delivery Challans.")

	def test_removing_dc_link_does_not_silently_drop_source(self):
		challan = self.make_dyeing_challan()
		receipt = self.mapped_receipt([challan]).insert(ignore_permissions=True)
		receipt.set("delivery_challans", [])
		with self.assertRaisesRegex(frappe.ValidationError, "not on the linked Delivery Challans"):
			receipt.save(ignore_permissions=True)

	def test_source_link_checks_its_own_template_mapping(self):
		self.make_input()
		other = self.make_challan()
		challan = self.make_dyeing_challan()
		receipt = self.mapped_receipt([challan])
		receipt.append("delivery_challans", {"delivery_challan": other.name})
		receipt.items[0].item = self.output_item
		with self.assertRaisesRegex(frappe.ValidationError, "is not an output of"):
			receipt.insert(ignore_permissions=True)

	def test_multi_dc_linked_outputs_are_exclusive_to_each_dc(self):
		challans = [self.make_dyeing_challan(), self.make_dyeing_challan()]
		receipt = self.mapped_receipt(challans)
		for row in receipt.items:
			row.item = self.variants["Blue"]
		receipt.insert(ignore_permissions=True).submit()
		for challan in challans:
			close = close_dc(challan)
			run_adjustments(close.doctype, close.name)
			self.assertEqual([row.goods_received_note_item for row in close.reload().outputs], [
				row.name for row in receipt.items if row.delivery_challan_item in {source.name for source in challan.items}
			])
			self.assertEqual([row.allocated_value for row in close.outputs], [1000, 3000])
		values = [row.valuation_adjustment_value for row in get_voucher_sles(receipt.doctype, receipt.name)]
		self.assertEqual(sorted(values), [1000, 1000, 3000, 3000])

	def test_every_conversion_output_links_its_source_row(self):
		challan = self.make_dyeing_challan()
		waste = make_item(stock_uom=self.yarn.stock_uom)
		set_process_outputs(self.yarn.name, self.process_name, [(self.yarn.name, 1, 1), (waste, 1, 2)])
		rows = get_converted_outputs(challan)
		self.assertEqual([row.delivery_challan_item for row in rows], [
			challan.items[0].name, challan.items[0].name, challan.items[1].name, challan.items[1].name,
		])

	def test_no_conversion_prefill_still_links_source_row(self):
		challan = self.make_dyeing_challan()
		set_process_outputs(self.yarn.name, self.process_name, [])
		rows = get_converted_outputs(challan)
		self.assertEqual([row.delivery_challan_item for row in rows], [row.name for row in challan.items])

	def test_plan_prefills_leave_source_link_empty(self):
		challan = self.make_dyeing_challan()
		plan = frappe.get_doc({
			"doctype": "MGK Process Planning",
			"items": [{"item": self.variants["Raw"], "qty": 10, **get_dimension_defaults()}],
		})
		save_process_plan(challan.name, frappe.as_json(get_item_details(plan)))
		rows = get_planned_outputs(challan.reload())
		self.assertFalse(any(row.get("delivery_challan_item") for row in rows))
		self.assertFalse(any(cell.get("delivery_challan_item") for cell in get_cells(get_item_details(self.mapped_receipt([challan])))))
