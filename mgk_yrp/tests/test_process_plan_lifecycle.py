import frappe

from mgk_yrp.job_work.process_plan import PLAN_DOCTYPE, get_process_plan, save_process_plan
from mgk_yrp.stock.item_editor import get_item_details
from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import close_dc, dimensioned_items, make_item, make_template_item


class TestProcessPlanLifecycle(CloseTestCase):
	def plan_groups(self, rows):
		plan = frappe.new_doc(PLAN_DOCTYPE)
		plan.set("items", dimensioned_items(rows))
		return get_item_details(plan)

	def test_amendment_clears_copied_plan_and_recomputed_progress(self):
		self.make_input()
		challan = self.make_challan()
		plan = save_process_plan(challan.name, self.plan_groups([{"item": self.output_item, "qty": 5}]))
		challan.reload().cancel()
		previous_close = close_dc(self.make_challan())
		amended = frappe.copy_doc(challan)
		self.assertEqual(amended.mgk_process_planning, plan)
		amended.update({
			"docstatus": 0, "amended_from": challan.name, "close_status": "Closed",
			"delivery_challan_close": previous_close.name, "is_internal_transfer": 1,
			"transit_warehouse": self.destination, "transfer_status": "Transferred",
		})
		amended.items[0].update({"returned_qty": 50, "transferred_qty": 50})
		amended.insert()
		for field in ("mgk_process_planning", "delivery_challan_close", "close_status",
			"is_internal_transfer", "transit_warehouse", "transfer_status"):
			self.assertFalse(amended.get(field), field)
		self.assertEqual((amended.items[0].returned_qty, amended.items[0].transferred_qty), (0, 0))
		self.assertEqual(challan.reload().mgk_process_planning, plan)
		self.assertEqual(get_process_plan(amended.name), [])

	def test_internal_amendment_recomputes_route_and_clears_transit_progress(self):
		self.make_input()
		challan = self.make_challan()
		challan.cancel()
		frappe.db.set_value("Supplier", self.supplier, "is_company_location", 1)
		amended = frappe.copy_doc(challan)
		amended.update({
			"docstatus": 0, "amended_from": challan.name,
			"is_internal_transfer": 0, "transit_warehouse": self.destination,
			"transfer_status": "Transferred",
		})
		amended.items[0].transferred_qty = 50
		amended.insert()
		self.assertEqual(amended.is_internal_transfer, 1)
		self.assertFalse(amended.transit_warehouse)
		self.assertFalse(amended.transfer_status)
		self.assertEqual(amended.items[0].transferred_qty, 0)

	def test_zero_plan_rows_are_dropped_beside_positive_rows(self):
		self.make_input()
		challan = self.make_challan()
		unmapped = make_item(stock_uom="Kg")
		groups = self.plan_groups([
			{"item": self.output_item, "qty": 7}, {"item": unmapped, "qty": 0},
		])
		name = save_process_plan(challan.name, groups)
		rows = frappe.get_doc(PLAN_DOCTYPE, name).items
		self.assertEqual([(row.item, row.qty, row.stock_qty) for row in rows], [(self.output_item, 7, 7)])

	def test_zero_plan_cells_do_not_create_missing_variants(self):
		self.make_input()
		challan = self.make_challan()
		template, attributes = make_template_item()
		attribute, value = next(iter(attributes.items()))
		groups = self.plan_groups([{"item": self.output_item, "qty": 7}])
		groups.append({"items": [{
			"name": template.name, "attributes": {}, "primary_attribute": attribute,
			"values": {value: {"qty": 0}},
		}]})
		name = save_process_plan(challan.name, groups)
		self.assertEqual(frappe.db.count("Item", {"variant_of": template.name}), 0)
		self.assertEqual([row.item for row in frappe.get_doc(PLAN_DOCTYPE, name).items], [self.output_item])
