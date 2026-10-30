from copy import deepcopy
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from yrp.yrp.doctype.yrp_item.yrp_item import ensure_global_attribute_values, get_or_create_variant

from mgk_yrp.job_work.grn_from_dc import (
	get_converted_outputs,
	get_planned_outputs,
	get_source_challan,
	make_job_work_grn,
	resolve_output_item,
	validate_output_templates,
)
from mgk_yrp.stock.dimensions import get_dimension_defaults
from mgk_yrp.stock.item_editor import get_item_details
from mgk_yrp.tests.fixtures import (
	close_dc,
	make_delivery_challan,
	make_item,
	make_item_attribute,
	make_item_group,
	make_po_grn,
	make_process,
	make_purchase_order,
	make_received_type,
	make_supplier,
	make_uom,
	make_warehouse,
)
from mgk_yrp.tests.fixtures import (
	make_job_work_grn as make_receipt,
)

MODULE = "mgk_yrp.job_work.grn_from_dc"


def make_template(attributes, primary, stock_uom="Kg"):
	name = f"MGK Jobwork Template {frappe.generate_hash(length=8)}"
	return frappe.get_doc({
		"doctype": "Item", "item_code": name, "item_name": name,
		"item_group": make_item_group(), "stock_uom": make_uom(stock_uom),
		"has_variants": 1, "primary_attribute": primary, "attributes": attributes,
	}).insert(ignore_permissions=True)


def add_attribute_value(attribute, value):
	ensure_global_attribute_values(attribute["attribute"], [value], check_permission=False)
	mapping = frappe.get_doc("YRP Item Item Attribute Mapping", attribute["mapping"])
	mapping.append("values", {"attribute_value": value})
	mapping.save(ignore_permissions=True)


class TestGRNFromDC(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.owner = make_supplier(is_company_location=1)
		self.supplier = make_supplier()
		self.main = make_warehouse(supplier=self.owner)
		self.vendor = make_warehouse(supplier=self.supplier)
		self.process = make_process()
		self.size, self.small = make_item_attribute()
		self.colour, self.red = make_item_attribute()
		self.large, self.blue = "Large", "Blue"
		add_attribute_value(self.size, self.large)
		add_attribute_value(self.colour, self.blue)
		self.attributes = [self.size, self.colour]
		self.template = make_template(self.attributes, self.size["attribute"])
		self.raw = self.variant(self.template)
		self.output = make_item(stock_uom=make_uom("Kg"))
		self.set_conversions([self.output])
		make_receipt(supplier=self.supplier, warehouse=self.main,
			items=[{"item": self.raw, "qty": 100, "rate": 100}])

	def variant(self, template, size=None, colour=None):
		return get_or_create_variant(template.name, {
			self.size["attribute"]: size or self.small,
			self.colour["attribute"]: colour or self.red,
		})

	def set_conversions(self, outputs):
		self.template.set("mgk_process_conversions", [
			{"process_name": self.process, "item": item, "from_qty": 1, "to_qty": 2}
			for item in outputs])
		self.template.save(ignore_permissions=True)

	def challan(self, items=None, **header):
		return make_delivery_challan(
			from_warehouse=header.pop("from_warehouse", self.main),
			to_supplier=header.pop("to_supplier", self.supplier),
			to_warehouse=header.pop("to_warehouse", self.vendor),
			process_name=header.pop("process_name", self.process),
			items=items or [{"item": self.raw, "qty": 10}], **header)

	def mapped(self, challans=None):
		return make_job_work_grn([row.name for row in (challans or [self.challan()])])

	def save_plan(self, challan, items=None):
		from mgk_yrp.job_work.process_plan import save_process_plan

		plan = frappe.get_doc({"doctype": "MGK Process Planning",
			"items": items or [{"item": self.output, "qty": 20, **get_dimension_defaults()}]})
		save_process_plan(challan.name, frappe.as_json(get_item_details(plan)))
		challan.reload()
		return frappe.get_doc("MGK Process Planning", challan.mgk_process_planning)

	def test_process_inferred_from_linked_dcs(self):
		receipt = self.mapped()
		receipt.process_name = None
		receipt.insert(ignore_permissions=True)
		self.assertEqual(receipt.process_name, self.process)

	def test_process_must_match_every_linked_dc(self):
		receipt = self.mapped()
		receipt.process_name = make_process()
		with self.assertRaisesRegex(frappe.ValidationError, "Process must match Delivery Challan"):
			receipt.insert(ignore_permissions=True)

	def test_linked_dcs_with_different_processes_throw(self):
		first, second = self.challan(), self.challan(process_name=make_process())
		receipt = self.mapped([first])
		receipt.append("delivery_challans", {"delivery_challan": second.name})
		with self.assertRaisesRegex(frappe.ValidationError, "Process must match Delivery Challan"):
			receipt.insert(ignore_permissions=True)

	def test_po_grn_ignores_process(self):
		order = make_purchase_order(supplier=self.supplier, warehouse=self.main,
			items=[{"item": self.output, "qty": 1, "rate": 1}])
		receipt = make_po_grn(order, submit=False)
		receipt.process_name = make_process()
		receipt.save(ignore_permissions=True)
		self.assertFalse(receipt.delivery_challans)

	def test_draft_keeps_prefilled_zero_rows(self):
		receipt = self.mapped().insert(ignore_permissions=True)
		receipt.item_details = frappe.as_json(get_item_details(receipt))
		receipt.save(ignore_permissions=True).reload()
		self.assertEqual([(row.qty, row.rate, row.is_prefilled) for row in receipt.items], [(0, 0, 1)])

	def test_submit_drops_zero_rows(self):
		receipt = self.mapped().insert(ignore_permissions=True)
		receipt.append("items", {"item": self.output, "qty": 3, "rate": 0})
		receipt.save(ignore_permissions=True).submit()
		self.assertEqual([row.qty for row in receipt.items], [3])

	def test_submit_all_zero_throws(self):
		receipt = self.mapped().insert(ignore_permissions=True)
		with self.assertRaisesRegex(frappe.ValidationError, "Enter at least one item with a positive quantity."):
			receipt.submit()

	def test_plain_output_is_returned_unchanged(self):
		self.assertEqual(resolve_output_item(self.output, self.raw), self.output)

	def test_missing_output_variant_created_once_with_primary_attribute(self):
		output = make_template(self.attributes, self.size["attribute"])
		first = resolve_output_item(output.name, self.raw)
		self.assertEqual(first, resolve_output_item(output.name, self.raw))
		attributes = {row.attribute: row.attribute_value for row in frappe.get_doc("Item", first).attributes}
		self.assertEqual(attributes, {self.size["attribute"]: self.small, self.colour["attribute"]: self.red})

	def test_missing_attribute_requires_update_plan(self):
		attribute, _value = make_item_attribute()
		output = make_template([attribute], attribute["attribute"])
		with self.assertRaisesRegex(frappe.ValidationError, "Use Update Plan on the Delivery Challan"):
			resolve_output_item(output.name, self.raw)

	def test_two_conversion_outputs_per_source_row(self):
		second = make_item(stock_uom=make_uom("Cone"))
		self.set_conversions([self.output, second])
		rows = get_converted_outputs(self.challan())
		self.assertEqual([row.item for row in rows], [self.output, second])
		self.assertEqual([row.uom for row in rows], ["Kg", "Cone"])
		for row in rows:
			self.assertEqual((row.qty, row.rate, row.is_prefilled), (0, 0, 1))
			self.assertEqual(row.received_type, get_dimension_defaults()["received_type"])

	def test_no_conversion_uses_dc_item(self):
		self.set_conversions([])
		self.assertEqual(get_converted_outputs(self.challan())[0].item, self.raw)

	def test_same_template_conversion_preserves_variant(self):
		self.set_conversions([self.template.name, self.output])
		self.assertEqual([row.item for row in get_converted_outputs(self.challan())], [self.raw, self.output])

	def test_identical_outputs_keep_separate_lines(self):
		challan = self.challan(items=[{"item": self.raw, "qty": 1}, {"item": self.raw, "qty": 2}])
		rows = get_converted_outputs(challan)
		self.assertEqual([row.item for row in rows], [self.output, self.output])
		self.assertEqual(len({row.row_index for row in rows}), 2)

	def test_sizes_of_source_line_share_row_index(self):
		self.set_conversions([self.template.name])
		challan = self.challan(submit=False)
		challan.items[0].row_index = "7"
		challan.append("items", {"item": self.variant(self.template, size=self.large), "row_index": "7", "qty": 1})
		rows = get_converted_outputs(challan)
		self.assertEqual(len(rows), 2)
		self.assertEqual(rows[0].row_index, rows[1].row_index)

	def test_single_mapping_header_and_onload(self):
		challan = self.challan()
		receipt = make_job_work_grn(source_name=challan.name)
		self.assertEqual((receipt.supplier, receipt.process_name), (self.supplier, self.process))
		self.assertEqual((receipt.delivery_location, receipt.warehouse), (self.owner, self.main))
		self.assertEqual(receipt.linked_delivery_challans, [challan.name])
		self.assertTrue(receipt.get_onload()["item_details"])
		self.assertEqual(receipt.insert(ignore_permissions=True).docstatus, 0)

	def test_invalid_source_states_rejected(self):
		challan = self.challan()
		for values in ({"docstatus": 0}, {"docstatus": 2}, {"is_return": 1},
			{"close_status": "Closed"}, {"close_status": "Reopening"}, {"is_internal_transfer": 1}):
			with self.subTest(values=values):
				challan.reload()
				challan.update(values)
				with patch(f"{MODULE}.frappe.get_doc", return_value=challan), self.assertRaises(frappe.ValidationError):
					get_source_challan(challan.name)

	def test_no_grn_create_permission(self):
		with patch(f"{MODULE}.frappe.has_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				make_job_work_grn("unused")

	def test_no_dc_read_permission(self):
		challan = self.challan()
		with patch.object(type(challan), "check_permission", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				make_job_work_grn(challan.name)

	def test_same_item_into_dc_source_bucket_rejected_at_save(self):
		self.set_conversions([])
		receipt = self.mapped()
		with self.assertRaisesRegex(frappe.ValidationError, r"Row 1: Unprocessed goods\? Use Return on the DC\."):
			receipt.insert(ignore_permissions=True)

	def test_same_item_into_another_warehouse_saves_submits_and_closes(self):
		self.set_conversions([])
		challan = self.challan()
		receipt = self.mapped([challan])
		receipt.warehouse = make_warehouse(supplier=self.owner)
		receipt.items[0].qty = 10
		receipt.insert(ignore_permissions=True).submit()
		close_dc(challan)
		self.assertEqual(receipt.docstatus, 1)

	def test_different_variant_same_warehouse_is_allowed(self):
		self.set_conversions([])
		receipt = self.mapped()
		receipt.items[0].item = self.variant(self.template, colour=self.blue)
		receipt.insert(ignore_permissions=True)

	def test_same_variant_into_dc_destination_rejected_at_save(self):
		self.set_conversions([])
		receipt = self.mapped()
		receipt.delivery_location, receipt.warehouse = self.supplier, self.vendor
		with self.assertRaises(frappe.ValidationError) as raised:
			receipt.insert(ignore_permissions=True)
		self.assertEqual(str(raised.exception),
			f"Row 1: {self.raw} cannot be received into the job worker's warehouse {self.vendor}.")

	def test_template_check_rejects_unmapped_output(self):
		receipt = self.mapped()
		receipt.items[0].item = make_item(stock_uom="Kg")
		with self.assertRaisesRegex(frappe.ValidationError, "is not an output of"):
			receipt.insert(ignore_permissions=True)

	def test_template_check_does_not_compare_attributes(self):
		output = make_template(self.attributes, self.size["attribute"])
		self.set_conversions([output.name])
		receipt = self.mapped()
		receipt.items[0].item = self.variant(output, colour=self.blue)
		receipt.insert(ignore_permissions=True)

	def test_template_check_accepts_any_linked_input(self):
		first = self.challan()
		other = make_item(stock_uom="Kg")
		second = self.challan(items=[{"item": other, "qty": 1}], submit=False)
		receipt = self.mapped([first])
		receipt.items[0].item = other
		receipt.append("delivery_challans", {"delivery_challan": second.name})
		with patch(f"{MODULE}.get_linked_challans", return_value=[first, second]):
			validate_output_templates(receipt)

	def test_input_template_is_not_a_fallback_when_conversion_exists(self):
		receipt = self.mapped()
		receipt.warehouse = make_warehouse(supplier=self.owner)
		receipt.items[0].item = self.raw
		with self.assertRaisesRegex(frappe.ValidationError, "is not an output of"):
			receipt.insert(ignore_permissions=True)

	def test_bulk_keeps_all_rows_and_unique_links(self):
		first, second = self.challan(), self.challan()
		receipt = make_job_work_grn(frappe.as_json([first.name, second.name, first.name]))
		self.assertEqual(receipt.linked_delivery_challans, [first.name, second.name])
		self.assertEqual([row.item for row in receipt.items], [self.output, self.output])
		self.assertEqual(len({row.row_index for row in receipt.items}), 2)
		receipt.insert(ignore_permissions=True)

	def test_bulk_requires_same_supplier_and_process(self):
		first = self.challan()
		other = make_supplier()
		second = self.challan(to_supplier=other, to_warehouse=make_warehouse(supplier=other))
		third = self.challan(process_name=make_process())
		for challan in (second, third):
			with self.subTest(challan=challan.name), self.assertRaisesRegex(
				frappe.ValidationError, "Selected Delivery Challans must have the same supplier and process."):
				self.mapped([first, challan])

	def test_bulk_different_source_warehouse_uses_settings_defaults(self):
		first = self.challan()
		second = self.challan(from_warehouse=make_warehouse(supplier=self.owner), submit=False)
		second.docstatus = 1
		with patch(f"{MODULE}.get_source_challan", side_effect=[first, second]), patch(
			f"{MODULE}.get_own_location", return_value={"location": self.owner, "warehouse": self.main}):
			receipt = self.mapped([first, second])
		self.assertEqual((receipt.delivery_location, receipt.warehouse), (self.owner, self.main))

	def test_plan_prefill_uses_items_dimensions_and_zero_quantity(self):
		challan = self.challan()
		plan = self.save_plan(challan, items=[{"item": self.output, "qty": 20,
			"received_type": make_received_type("Rejected")}])
		rows = get_planned_outputs(challan)
		self.assertEqual([(row.item, row.qty, row.rate) for row in rows], [(self.output, 0, 0)])
		self.assertEqual(rows[0].received_type, plan.items[0].received_type)

	def test_bulk_combines_plan_and_conversion(self):
		first, second = self.challan(), self.challan()
		self.save_plan(first, items=[{"item": self.output, "qty": 1}, {"item": self.output, "qty": 2}])
		receipt = self.mapped([first, second])
		self.assertEqual(len(receipt.items), 3)
		self.assertEqual(len({row.row_index for row in receipt.items}), 3)

	def test_identical_plan_rows_from_two_dcs_stay_separate(self):
		first, second = self.challan(), self.challan()
		self.save_plan(first)
		self.save_plan(second)
		receipt = self.mapped([first, second])
		self.assertEqual(len(receipt.items), 2)
		self.assertNotEqual(receipt.items[0].row_index, receipt.items[1].row_index)

	def test_plan_edit_does_not_touch_existing_draft_grn(self):
		second = make_item(stock_uom="Kg")
		self.set_conversions([self.output, second])
		challan = self.challan()
		self.save_plan(challan)
		receipt = self.mapped([challan]).insert(ignore_permissions=True)
		plan = frappe.get_doc("MGK Process Planning", challan.mgk_process_planning)
		plan.items[0].item = second
		plan.save(ignore_permissions=True)
		receipt.reload()
		self.assertEqual((receipt.items[0].item, receipt.items[0].qty), (self.output, 0))
		self.assertEqual(self.mapped([challan]).items[0].item, second)

	def split_payload(self):
		output = make_template(self.attributes, self.size["attribute"])
		self.set_conversions([output.name])
		receipt = self.mapped().insert(ignore_permissions=True)
		groups = get_item_details(receipt)
		split = deepcopy(groups[0]["items"][0])
		split["attributes"][self.colour["attribute"]] = self.blue
		for cell in split["values"].values():
			cell.pop("name", None)
		groups[0]["items"].append(split)
		return receipt, output, groups

	def test_untouched_zero_cells_create_no_variants(self):
		receipt, output, groups = self.split_payload()
		groups[0]["items"].pop()
		before = frappe.db.count("Item", {"variant_of": output.name})
		receipt.item_details = frappe.as_json(groups)
		receipt.save(ignore_permissions=True)
		self.assertEqual(frappe.db.count("Item", {"variant_of": output.name}), before)
		self.assertEqual(len(receipt.items), 1)

	def test_split_row_with_new_colour_creates_variant_on_save(self):
		receipt, output, groups = self.split_payload()
		self.assertEqual(frappe.db.count("Item", {"variant_of": output.name}), 1)
		receipt.item_details = frappe.as_json(groups)
		receipt.save(ignore_permissions=True)
		self.assertEqual(frappe.db.count("Item", {"variant_of": output.name}), 2)
		self.assertEqual(len(receipt.items), 2)
		variant = frappe.get_doc("Item", receipt.items[1].item)
		self.assertIn(self.blue, [row.attribute_value for row in variant.attributes])

	def test_split_of_one_size_creates_no_variants_for_other_sizes(self):
		receipt, output, groups = self.split_payload()
		receipt.item_details = frappe.as_json(groups)
		receipt.save(ignore_permissions=True)
		variants = frappe.get_all("Item", {"variant_of": output.name}, pluck="name")
		self.assertEqual(len(variants), 2)
		for name in variants:
			values = {row.attribute: row.attribute_value for row in frappe.get_doc("Item", name).attributes}
			self.assertEqual(values[self.size["attribute"]], self.small)
