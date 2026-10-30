import json
from copy import deepcopy
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, getdate, nowdate
from yrp.stock.ageing import FIFOSlots
from yrp.yrp_stock.report.yrp_stock_balance.yrp_stock_balance import execute

from mgk_yrp.tests.fixtures import (
	make_item,
	make_job_work_grn,
	make_received_type,
	make_supplier,
	make_uom,
	make_warehouse,
)
from mgk_yrp.web.stock_balance import inward_dates
from mgk_yrp.web.stock_fifo import StockFIFO
from mgk_yrp.web.stock_note import allowed_warehouses, get_stock_note, report_filters, stock_filters

MODULE = "mgk_yrp.web.stock_note"


class TestWebStockNote(IntegrationTestCase):
	def test_authorized_fifo_keeps_desk_consumption_returns_reconciliation_and_negative_stock_dates(self):
		entries = []
		movements = [(5, 5, "GRN", "One"), (3, 8, "GRN", "Two"), (-6, 2, "DC", "Move"),
			(1, 3, "DC", "Move"), (0, 2, "YRP Stock Reconciliation", "Count"),
			(-4, -2, "DC", "Out"), (3, 1, "GRN", "Three")]
		for index, (quantity, balance, voucher_type, voucher_no) in enumerate(movements):
			entries.append(frappe._dict(
				item="Yarn", warehouse="Store", received_type="Accepted", qty=quantity,
				qty_after_transaction=balance, posting_date=getdate(add_days(nowdate(), index)),
				voucher_type=voucher_type, voucher_no=voucher_no,
			))
		key = ("Yarn", "Store", "Accepted")
		for count in range(1, len(entries) + 1):
			local = StockFIFO(["received_type"]).generate(entries[:count])
			with patch("yrp.stock.ageing.get_dimension_fieldnames", return_value=["received_type"]):
				desk = FIFOSlots({"show_warehouse_wise_stock": True}, deepcopy(entries[:count])).generate()
			self.assertEqual(inward_dates(local[key]), inward_dates(desk[key]["fifo_queue"]), count)
		self.assertEqual(inward_dates(local[key]), [{"date": getdate(add_days(nowdate(), 6)).strftime("%d-%m-%Y"), "qty": 1}])

	def test_checks_both_read_permissions_before_queries(self):
		for denied in ("YRP Stock Ledger Entry", "Warehouse"):
			def check(doctype, **kwargs):
				if doctype == denied:
					raise frappe.PermissionError
				return True

			with (
				patch(f"{MODULE}.frappe.has_permission", side_effect=check) as permission,
				patch(f"{MODULE}.allowed_warehouses") as query,
				self.assertRaises(frappe.PermissionError),
			):
				get_stock_note({})
			query.assert_not_called()
			self.assertTrue(all(call.kwargs == {"ptype": "read", "throw": True} for call in permission.call_args_list))

	def test_defaults_dates_and_rejects_bad_payloads(self):
		filters = stock_filters({})
		self.assertEqual(str(filters.to_date), nowdate())
		self.assertEqual(str(filters.from_date), add_days(nowdate(), -30))
		for value in ("bad JSON", "[]", [], {"warehouse": ["A"]}, {"from_date": "2026-10-30", "to_date": "2026-10-01"}):
			with self.subTest(value=value), self.assertRaises(frappe.ValidationError):
				stock_filters(value)

	def test_report_filters_match_desk_and_intersect_supplier_warehouse(self):
		warehouses = [frappe._dict(name="A", supplier="S"), frappe._dict(name="B", supplier="T")]
		filters = stock_filters(json.dumps({"supplier": "S", "item": "Yarn", "received_type": "Accepted"}))
		result = report_filters(filters, warehouses)
		self.assertEqual(result.warehouse, ["A"])
		self.assertEqual(result.parent_item, "Yarn")
		self.assertEqual(result.received_type, "Accepted")
		self.assertEqual(result.remove_zero_balance_item, 1)
		self.assertEqual(result.show_inward_date_split, 1)
		filters.warehouse = "B"
		self.assertEqual(report_filters(filters, warehouses).warehouse, ["__no_permitted_warehouse__"])
		filters.warehouse = "Hidden"
		with self.assertRaises(frappe.PermissionError):
			report_filters(filters, warehouses)

	def test_absent_warehouse_user_doctype_and_users_without_rows_are_unrestricted(self):
		for exists, restricted in ((False, []), (True, []), (True, ["A"])):
			with (
				patch(f"{MODULE}.frappe.db.exists", return_value=exists),
				patch(f"{MODULE}.frappe.get_all", return_value=restricted) as children,
				patch(f"{MODULE}.frappe.get_list", return_value=[]) as warehouses,
			):
				allowed_warehouses()
			if not exists:
				children.assert_not_called()
			self.assertEqual(warehouses.call_args.kwargs["filters"], {"disabled": 0, **({"name": ["in", ["A"]]} if restricted else {})})

	def test_no_permitted_warehouses_never_runs_an_unrestricted_report(self):
		with (
			patch(f"{MODULE}.frappe.has_permission", return_value=True),
			patch(f"{MODULE}.allowed_warehouses", return_value=[]),
			patch(f"{MODULE}.stock_options", return_value={"suppliers": []}),
			patch(f"{MODULE}.run_stock_balance", return_value=([], [])) as report,
		):
			result = get_stock_note({})
		self.assertEqual(report.call_args.args[0].warehouse, ["__no_permitted_warehouse__"])
		self.assertEqual(result["summary"], {"line_count": 0, "warehouse_count": 0, "total_value": 0, "uom_totals": {}})

	def test_summary_keeps_uoms_separate_and_preserves_report_values(self):
		rows = [frappe._dict(item="Yarn", warehouse="A", stock_uom="Kg", bal_qty=2.5, bal_val=125.126),
			frappe._dict(item="Fabric", warehouse="B", stock_uom="Mtr", bal_qty=3, bal_val=90)]
		warehouses = [frappe._dict(name="A", supplier="S", warehouse_name="Store"), frappe._dict(name="B", supplier=None)]
		with (
			patch(f"{MODULE}.frappe.has_permission", return_value=True),
			patch(f"{MODULE}.allowed_warehouses", return_value=warehouses),
			patch(f"{MODULE}.readable_supplier_warehouses", return_value=warehouses),
			patch(f"{MODULE}.stock_options", return_value={"suppliers": [frappe._dict(name="S", supplier_name="Vendor")]}),
			patch(f"{MODULE}.run_stock_balance", return_value=([], rows)),
		):
			result = get_stock_note({})
		self.assertEqual(result["summary"]["uom_totals"], {"Kg": 2.5, "Mtr": 3})
		self.assertEqual(result["summary"]["warehouse_count"], 2)
		self.assertEqual(result["summary"]["total_value"], 215.13)
		self.assertEqual(result["rows"][0].supplier_name, "Vendor")
		self.assertEqual(result["rows"][0].bal_val, 125.126)

	def test_real_stock_matches_desk_report_for_identical_filters(self):
		self.addCleanup(frappe.set_user, frappe.session.user)
		frappe.set_user("Administrator")
		supplier = make_supplier()
		warehouse = make_warehouse(supplier=supplier)
		item = make_item(stock_uom=make_uom("Kg"))
		received_type = make_received_type()
		make_job_work_grn(supplier=supplier, warehouse=warehouse, items=[
			{"item": item, "qty": 3, "rate": 12.5, "received_type": received_type},
		])
		filters = {"from_date": add_days(nowdate(), -30), "to_date": nowdate(), "warehouse": warehouse,
			"supplier": supplier, "item": item, "received_type": received_type}
		web = get_stock_note(filters)
		_columns, desk = execute(report_filters(stock_filters(filters), allowed_warehouses()))
		self.assertTrue(desk)
		self.assertEqual(len(web["rows"]), len(desk))
		for actual, expected in zip(web["rows"], desk, strict=True):
			for field in ("item", "warehouse", "received_type", "bal_qty", "bal_val", "stock_uom", "inward_date_breakdown", "inward_split"):
				self.assertEqual(actual.get(field), expected.get(field), field)
		self.assertEqual(web["summary"]["uom_totals"], {"Kg": 3})

	def restricted_stock(self):
		self.addCleanup(frappe.set_user, frappe.session.user)
		frappe.set_user("Administrator")
		supplier = make_supplier()
		warehouse = make_warehouse(supplier=supplier)
		items = [make_item(stock_uom=make_uom("Kg")) for _ in range(2)]
		received_type = make_received_type()
		make_job_work_grn(supplier=supplier, warehouse=warehouse, items=[
			{"item": items[0], "qty": 3, "rate": 10, "received_type": received_type},
			{"item": items[1], "qty": 7, "rate": 20, "received_type": received_type},
		])
		user = frappe.get_doc({
			"doctype": "User", "email": f"mgk-stock-note-{frappe.generate_hash(length=8)}@example.com",
			"first_name": "Stock Note Test", "send_welcome_email": 0,
			"roles": [{"role": "Stock User"}],
		}).insert(ignore_permissions=True)
		return user.name, warehouse, items, received_type

	def add_permission(self, user, doctype, name):
		frappe.get_doc({
			"doctype": "User Permission", "user": user, "allow": doctype,
			"for_value": name, "apply_to_all_doctypes": 1,
		}).insert(ignore_permissions=True)
		frappe.clear_cache(user=user)

	def test_item_permissions_filter_stock_rows_and_totals_and_reject_explicit_hidden_item(self):
		user, warehouse, items, _received_type = self.restricted_stock()
		self.add_permission(user, "Item", items[0])
		frappe.set_user(user)
		result = get_stock_note({"warehouse": warehouse})
		self.assertEqual({row.item for row in result["rows"]}, {items[0]})
		self.assertEqual(result["summary"]["uom_totals"], {"Kg": 3})
		self.assertEqual(result["summary"]["total_value"], 30)
		self.assertNotIn(items[1], {row.name for row in result["options"]["items"]})
		with self.assertRaises(frappe.PermissionError):
			get_stock_note({"warehouse": warehouse, "item": items[1]})

	def test_ledger_record_permissions_apply_before_aggregation(self):
		user, warehouse, items, received_type = self.restricted_stock()
		supplier = frappe.db.get_value("Warehouse", warehouse, "supplier")
		second = make_job_work_grn(supplier=supplier, warehouse=warehouse, items=[
			{"item": items[0], "qty": 2, "rate": 10, "received_type": received_type},
		])
		entry = frappe.db.get_value("YRP Stock Ledger Entry", {"voucher_type": second.doctype, "voucher_no": second.name}, "name")
		self.add_permission(user, "YRP Stock Ledger Entry", entry)
		frappe.set_user(user)
		result = get_stock_note({"warehouse": warehouse})
		self.assertEqual(result["summary"]["uom_totals"], {"Kg": 2})
		self.assertEqual(result["summary"]["total_value"], 20)
		self.assertEqual(result["rows"][0].inward_date_breakdown[0]["qty"], 2)

	def test_supplier_warehouse_and_dimension_permissions_reject_hidden_filters(self):
		user, warehouse, items, received_type = self.restricted_stock()
		supplier = frappe.db.get_value("Warehouse", warehouse, "supplier")
		hidden_supplier = make_supplier()
		hidden_warehouse = make_warehouse(supplier=hidden_supplier)
		hidden_type = make_received_type(f"MGK Hidden Type {frappe.generate_hash(length=8)}")
		make_job_work_grn(supplier=supplier, warehouse=warehouse, items=[
			{"item": items[0], "qty": 4, "rate": 50, "received_type": hidden_type},
		])
		self.add_permission(user, "Supplier", supplier)
		self.add_permission(user, "Warehouse", warehouse)
		self.add_permission(user, "YRP Received Type", received_type)
		frappe.set_user(user)
		for filters in ({"supplier": hidden_supplier}, {"warehouse": hidden_warehouse}, {"received_type": hidden_type}):
			with self.subTest(filters=filters), self.assertRaises(frappe.PermissionError):
				get_stock_note(filters)
		result = get_stock_note({})
		self.assertTrue(result["rows"])
		self.assertEqual({row.warehouse for row in result["rows"]}, {warehouse})
		self.assertEqual({row.received_type for row in result["rows"]}, {received_type})
		self.assertEqual(result["summary"]["total_value"], 170)
