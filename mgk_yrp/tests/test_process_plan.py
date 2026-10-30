import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

import frappe
from frappe.model.document import Document
from frappe.tests import IntegrationTestCase
from yrp.yrp.doctype.yrp_item.yrp_item import create_variant

from mgk_yrp.job_work.process_plan import (
	PLAN_DOCTYPE,
	get_editable_challan,
	get_process_plan,
	save_process_plan,
)
from mgk_yrp.mgk_yrp.doctype.mgk_process_planning.mgk_process_planning import MGKProcessPlanning
from mgk_yrp.stock.dimensions import get_dimension_defaults
from mgk_yrp.stock.item_editor import get_item_details
from mgk_yrp.stock.locking import LOCK_ORDER, lock_documents
from mgk_yrp.tests.fixtures import (
	close_dc,
	dimensioned_items,
	make_delivery_challan,
	make_item,
	make_item_attribute,
	make_item_group,
	make_job_work_grn,
	make_po_grn,
	make_process,
	make_purchase_order,
	make_return,
	make_supplier,
	make_uom,
	make_warehouse,
)

PLANNING = "mgk_yrp.job_work.process_plan"
CONTROLLER = MGKProcessPlanning.__module__


def make_planning_template():
	attribute, value = make_item_attribute()
	name = f"MGK Planning Template {frappe.generate_hash(length=8)}"
	template = frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": name,
			"item_name": name,
			"item_group": make_item_group(),
			"stock_uom": make_uom("Kg"),
			"is_stock_item": 1,
			"has_variants": 1,
			"primary_attribute": attribute["attribute"],
			"attributes": [attribute],
		}
	).insert(ignore_permissions=True)
	return template, {attribute["attribute"]: value}


class TestProcessPlan(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.enterContext(patch("frappe.enqueue"))
		self.owner = make_supplier(is_company_location=1)
		self.supplier = make_supplier()
		self.main = make_warehouse(supplier=self.owner)
		self.destination = make_warehouse(supplier=self.supplier)
		self.template, self.attributes = make_planning_template()
		self.item = create_variant(self.template.name, self.attributes).insert(ignore_permissions=True).name
		self.process = make_process()
		order = make_purchase_order(
			supplier=self.supplier,
			warehouse=self.main,
			items=[{"item": self.item, "qty": 100, "rate": 10}],
		)
		make_po_grn(order)
		self.challan = self.make_challan()

	def make_challan(self, **header):
		return make_delivery_challan(
			from_warehouse=self.main,
			to_supplier=self.supplier,
			to_warehouse=self.destination,
			process_name=self.process,
			items=[{"item": self.item, "qty": 10}],
			**header,
		)

	def payload(self, quantity=5, item=None):
		plan = frappe.new_doc(PLAN_DOCTYPE)
		plan.set("items", dimensioned_items([{"item": item or self.item, "qty": quantity}]))
		return json.dumps(get_item_details(plan))

	def save_plan(self, quantity=5, item=None):
		return save_process_plan(self.challan.name, self.payload(quantity, item))

	def add_conversion(self, output):
		self.template.append(
			"mgk_process_conversions",
			{"process_name": self.process, "item": output, "from_qty": 1, "to_qty": 2},
		)
		self.template.save(ignore_permissions=True)

	def deny_permission(self, permission, doctype=PLAN_DOCTYPE):
		original = Document.check_permission

		def check(document, permission_type="read", *args, **kwargs):
			if document.doctype == doctype and permission_type == permission:
				raise frappe.PermissionError
			return original(document, permission_type, *args, **kwargs)

		return patch.object(Document, "check_permission", check)

	def test_create_links_dc_and_resolves_uom_and_dimensions(self):
		name = self.save_plan()
		self.assertEqual(name, self.challan.name)
		self.assertEqual(self.challan.reload().mgk_process_planning, name)
		plan = frappe.get_doc(PLAN_DOCTYPE, name)
		self.assertEqual((plan.supplier, plan.process_name), (self.supplier, self.process))
		row = plan.items[0]
		self.assertEqual((row.item, row.qty, row.stock_qty), (self.item, 5, 5))
		self.assertEqual((row.uom, row.stock_uom, row.conversion_factor), ("Kg", "Kg", 1))
		for field, value in get_dimension_defaults().items():
			self.assertEqual(row.get(field), value)

	def test_update_replaces_rows(self):
		name = self.save_plan()
		old = frappe.get_doc(PLAN_DOCTYPE, name).items[0].name
		self.save_plan(8)
		rows = frappe.get_doc(PLAN_DOCTYPE, name).items
		self.assertEqual([row.qty for row in rows], [8])
		self.assertNotEqual(rows[0].name, old)
		self.assertFalse(frappe.db.exists("MGK Process Planning Item", old))

	def test_empty_payload_deletes_plan_and_clears_link(self):
		name = self.save_plan()
		self.assertIsNone(save_process_plan(self.challan.name, "[]"))
		self.assertFalse(frappe.db.exists(PLAN_DOCTYPE, name))
		self.assertFalse(self.challan.reload().mgk_process_planning)

	def test_zero_cells_delete_plan_without_creating_variants(self):
		self.save_plan()
		before = frappe.db.count("Item", {"variant_of": self.template.name})
		self.assertIsNone(self.save_plan(0))
		self.assertEqual(frappe.db.count("Item", {"variant_of": self.template.name}), before)
		self.assertFalse(self.challan.reload().mgk_process_planning)

	def test_empty_payload_without_plan_is_a_noop(self):
		self.assertIsNone(save_process_plan(self.challan.name, []))
		self.assertFalse(frappe.db.exists(PLAN_DOCTYPE, self.challan.name))

	def test_missing_output_variant_is_created(self):
		output, attributes = make_planning_template()
		self.add_conversion(output.name)
		attribute, value = next(iter(attributes.items()))
		groups = [{"items": [{"name": output.name, "attributes": {}, "primary_attribute": attribute,
			"dimensions": get_dimension_defaults(), "values": {value: {"qty": 4}}}]}]
		self.assertEqual(frappe.db.count("Item", {"variant_of": output.name}), 0)
		name = save_process_plan(self.challan.name, groups)
		item = frappe.get_doc(PLAN_DOCTYPE, name).items[0].item
		self.assertEqual(frappe.db.get_value("Item", item, "variant_of"), output.name)
		self.assertEqual(frappe.db.count("Item", {"variant_of": output.name}), 1)

	def test_partial_submitted_grn_does_not_block_update(self):
		warehouse = make_warehouse(supplier=self.owner)
		make_job_work_grn(
			supplier=self.supplier, warehouse=warehouse, delivery_challans=[self.challan.name],
			items=[{"item": self.item, "qty": 2}],
		)
		self.save_plan()
		self.save_plan(9)
		self.assertEqual(frappe.get_doc(PLAN_DOCTYPE, self.challan.name).items[0].qty, 9)

	def test_closed_and_reopening_dc_block_save(self):
		for status in ("Closed", "Reopening"):
			with self.subTest(status=status):
				frappe.db.set_value("MGK Delivery Challan", self.challan.name, "close_status", status)
				with self.assertRaisesRegex(frappe.ValidationError, status):
					self.save_plan()

	def test_draft_and_cancelled_dc_block_save(self):
		draft = self.make_challan(submit=False)
		with self.assertRaisesRegex(frappe.ValidationError, "Only submitted"):
			save_process_plan(draft.name, self.payload())
		self.challan.cancel()
		with self.assertRaisesRegex(frappe.ValidationError, "Only submitted"):
			self.save_plan()

	def test_return_dc_blocks_save(self):
		returned = make_return(self.challan, {self.challan.items[0].name: 1})
		with self.assertRaisesRegex(frappe.ValidationError, "non-return"):
			save_process_plan(returned.name, self.payload())

	def test_internal_dc_blocks_save(self):
		frappe.db.set_value("MGK Delivery Challan", self.challan.name, "is_internal_transfer", 1)
		with self.assertRaisesRegex(frappe.ValidationError, "[Ii]nternal"):
			self.save_plan()

	def test_reopened_dc_allows_plan_update(self):
		self.save_plan()
		closed = close_dc(self.challan)
		with self.assertRaisesRegex(frappe.ValidationError, "Closed"):
			self.save_plan(8)
		closed.cancel()
		self.assertEqual(self.challan.reload().close_status, "Open")
		self.save_plan(8)
		self.assertEqual(frappe.get_doc(PLAN_DOCTYPE, self.challan.name).items[0].qty, 8)

	def test_create_and_write_permissions_are_required(self):
		with self.deny_permission("create"), self.assertRaises(frappe.PermissionError):
			self.save_plan()
		self.assertFalse(frappe.db.exists(PLAN_DOCTYPE, self.challan.name))
		name = self.save_plan()
		with self.deny_permission("write"), self.assertRaises(frappe.PermissionError):
			self.save_plan(9)
		self.assertEqual(frappe.get_doc(PLAN_DOCTYPE, name).items[0].qty, 5)

	def test_empty_payload_requires_delete_permission_without_mutation(self):
		name = self.save_plan()
		with self.deny_permission("delete"), self.assertRaises(frappe.PermissionError):
			save_process_plan(self.challan.name, [])
		self.assertEqual(self.challan.reload().mgk_process_planning, name)
		self.assertEqual(frappe.get_doc(PLAN_DOCTYPE, name).items[0].qty, 5)

	def test_direct_save_and_trash_on_closed_dc_throw(self):
		name = self.save_plan()
		frappe.db.set_value("MGK Delivery Challan", self.challan.name, "close_status", "Closed")
		plan = frappe.get_doc(PLAN_DOCTYPE, name)
		with self.assertRaisesRegex(frappe.ValidationError, "Closed"):
			plan.save()
		with self.assertRaisesRegex(frappe.ValidationError, "Closed"):
			frappe.delete_doc(PLAN_DOCTYPE, name)
		self.assertTrue(frappe.db.exists(PLAN_DOCTYPE, name))
		self.assertEqual(self.challan.reload().mgk_process_planning, name)

	def test_changing_delivery_challan_throws(self):
		plan = frappe.get_doc(PLAN_DOCTYPE, self.save_plan())
		plan.delivery_challan = self.make_challan().name
		with self.assertRaisesRegex(frappe.ValidationError, "cannot be changed"):
			plan.save()

	def test_new_plan_with_wrong_name_throws(self):
		plan = frappe.new_doc(PLAN_DOCTYPE)
		plan.delivery_challan = self.challan.name
		plan.set("items", dimensioned_items([{"item": self.item, "qty": 1}]))
		with self.assertRaisesRegex(frappe.ValidationError, "named after"):
			plan.insert(set_name="MGK-Wrong-Plan")

	def test_foreign_dc_plan_link_throws_after_submit(self):
		other = self.make_challan()
		other_plan = save_process_plan(other.name, self.payload())
		self.challan.mgk_process_planning = other_plan
		with self.assertRaisesRegex(frappe.ValidationError, "must belong"):
			self.challan.save()

	def test_direct_trash_clears_link(self):
		name = self.save_plan()
		frappe.delete_doc(PLAN_DOCTYPE, name)
		self.assertFalse(self.challan.reload().mgk_process_planning)

	def test_get_returns_groups_and_requires_plan_read(self):
		self.assertEqual(get_process_plan(self.challan.name), [])
		self.save_plan()
		groups = get_process_plan(self.challan.name)
		self.assertEqual(groups, get_item_details(frappe.get_doc(PLAN_DOCTYPE, self.challan.name)))
		with self.deny_permission("read"), self.assertRaises(frappe.PermissionError):
			get_process_plan(self.challan.name)

	def test_dc_read_permission_is_required_for_read_and_save(self):
		with self.deny_permission("read", "MGK Delivery Challan"):
			with self.assertRaises(frappe.PermissionError):
				get_process_plan(self.challan.name)
			with self.assertRaises(frappe.PermissionError):
				self.save_plan()

	def test_save_process_plan_locks_dc_before_plan(self):
		with patch(f"{PLANNING}.lock_documents", wraps=lock_documents) as locking:
			self.save_plan()
		self.assertEqual(locking.call_args_list[0].args[0], {
			"MGK Delivery Challan": [self.challan.name], PLAN_DOCTYPE: [self.challan.name],
		})

	def test_amended_dc_has_no_plan_link(self):
		self.save_plan()
		self.challan.reload().cancel()
		amended = frappe.copy_doc(self.challan)
		amended.docstatus = 0
		amended.amended_from = self.challan.name
		amended.insert()
		self.assertFalse(amended.mgk_process_planning)

	def test_cancelled_dc_keeps_plan(self):
		name = self.save_plan()
		self.challan.reload().cancel()
		self.assertEqual(self.challan.reload().mgk_process_planning, name)
		self.assertTrue(frappe.db.exists(PLAN_DOCTYPE, name))
		self.assertTrue(get_process_plan(self.challan.name))

	def test_unmapped_template_is_rejected(self):
		output = make_item(stock_uom="Kg")
		with self.assertRaisesRegex(frappe.ValidationError, "Row 1: .* is not an output of .* for process"):
			self.save_plan(item=output)

	def test_mapped_output_and_same_template_fallback(self):
		self.save_plan()
		output = make_item(stock_uom=make_uom("Nos"))
		self.add_conversion(output)
		self.save_plan(item=output)
		plan = frappe.get_doc(PLAN_DOCTYPE, self.challan.name)
		self.assertEqual((plan.items[0].item, plan.items[0].uom), (output, "Nos"))
		with self.assertRaisesRegex(frappe.ValidationError, "is not an output"):
			self.save_plan(item=self.item)

	def test_no_variant_attribute_validation(self):
		output, attributes = make_planning_template()
		variant = create_variant(output.name, attributes).insert(ignore_permissions=True)
		self.add_conversion(output.name)
		self.save_plan(item=variant.name)
		self.assertEqual(frappe.get_doc(PLAN_DOCTYPE, self.challan.name).items[0].item, variant.name)

	def test_same_template_conversion_is_allowed(self):
		self.add_conversion(self.template.name)
		self.save_plan()
		self.assertEqual(frappe.get_doc(PLAN_DOCTYPE, self.challan.name).items[0].item, self.item)

	def test_outputs_from_each_input_template_are_allowed(self):
		second = make_item(stock_uom="Kg")
		order = make_purchase_order(supplier=self.supplier, warehouse=self.main,
			items=[{"item": second, "qty": 10, "rate": 10}])
		make_po_grn(order)
		self.challan = make_delivery_challan(
			from_warehouse=self.main, to_supplier=self.supplier, to_warehouse=self.destination,
			process_name=self.process, items=[{"item": self.item, "qty": 1}, {"item": second, "qty": 1}],
		)
		output = make_item(stock_uom="Kg")
		self.add_conversion(output)
		groups = json.loads(self.payload(item=output)) + json.loads(self.payload(item=second))
		name = save_process_plan(self.challan.name, groups)
		self.assertEqual([row.item for row in frappe.get_doc(PLAN_DOCTYPE, name).items], [output, second])

	def test_negative_quantity_and_spoofed_uom(self):
		with self.assertRaisesRegex(frappe.ValidationError, "Quantity must be positive"):
			self.save_plan(-1)
		plan = frappe.get_doc(PLAN_DOCTYPE, self.save_plan())
		plan.items[0].update({"uom": make_uom("Nos"), "stock_uom": "Nos", "conversion_factor": 99})
		plan.save()
		self.assertEqual((plan.items[0].uom, plan.items[0].stock_qty), ("Kg", 5))


class TestProcessPlanLocksAndSchema(TestCase):
	def test_schema_and_dc_link(self):
		root = Path(__file__).parents[1] / "mgk_yrp" / "doctype"
		plan = json.loads((root / "mgk_process_planning" / "mgk_process_planning.json").read_text())
		self.assertEqual((plan["autoname"], plan["in_create"]), ("field:delivery_challan", 1))
		fields = {field["fieldname"]: field for field in plan["fields"]}
		self.assertTrue(fields["delivery_challan"]["unique"])
		self.assertTrue(fields["delivery_challan"]["set_only_once"])
		self.assertTrue(fields["items"]["read_only"])
		challan = json.loads((root / "mgk_delivery_challan" / "mgk_delivery_challan.json").read_text())
		link = next(field for field in challan["fields"] if field["fieldname"] == "mgk_process_planning")
		self.assertEqual((link["options"], link["allow_on_submit"], link["no_copy"]), (PLAN_DOCTYPE, 1, 1))

	def test_lock_order_places_plan_between_dc_and_grn(self):
		self.assertLess(LOCK_ORDER.index("MGK Delivery Challan"), LOCK_ORDER.index(PLAN_DOCTYPE))
		self.assertLess(LOCK_ORDER.index(PLAN_DOCTYPE), LOCK_ORDER.index("MGK Goods Received Note"))
		database = Mock()
		with patch("frappe.db", database, create=True):
			lock_documents({PLAN_DOCTYPE: ["DC-1"], "MGK Delivery Challan": ["DC-1"]})
		queries = [arguments.args[0] for arguments in database.sql.call_args_list]
		self.assertIn("`tabMGK Delivery Challan`", queries[0])
		self.assertIn("`tabMGK Process Planning`", queries[1])

	def test_edit_locks_before_for_update_read(self):
		operations = Mock()
		operations.get_doc.return_value = Mock(docstatus=1, is_return=0)
		with (
			patch(f"{PLANNING}.lock_documents", operations.lock),
			patch("frappe.get_doc", operations.get_doc),
			patch(f"{PLANNING}.transit.reject_internal_action"),
		):
			get_editable_challan("DC-1")
		self.assertEqual(operations.mock_calls[0].args[0],
			{"MGK Delivery Challan": ["DC-1"], PLAN_DOCTYPE: ["DC-1"]})
		self.assertEqual(operations.mock_calls[1].kwargs, {"for_update": True})

	def test_existing_plan_locks_dc_before_frappe_locks_plan(self):
		plan = Mock(spec=MGKProcessPlanning, is_new=lambda: False)
		operations = Mock()
		plan.get_challan = operations.challan
		with patch.object(Document, "load_doc_before_save", operations.load):
			MGKProcessPlanning.load_doc_before_save(plan, raise_exception=True)
		self.assertEqual([operation[0] for operation in operations.mock_calls], ["challan", "load"])

	def test_absent_plan_still_requires_plan_read_permission(self):
		challan = Mock(name="DC-1")
		with (
			patch("frappe.get_doc", return_value=challan),
			patch("frappe.db", Mock(exists=Mock(return_value=False)), create=True),
			patch("frappe.has_permission", side_effect=frappe.PermissionError) as permission,
			self.assertRaises(frappe.PermissionError),
		):
			get_process_plan("DC-1")
		permission.assert_called_once_with(PLAN_DOCTYPE, "read", throw=True)
