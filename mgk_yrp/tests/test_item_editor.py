import json
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

import frappe

from mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan import (
	MGKDeliveryChallan,
	make_return_delivery_challan,
)
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import MGKGoodsReceivedNote
from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import MGKPurchaseOrder
from mgk_yrp.stock.item_editor import (
	drop_zero_qty_rows,
	get_cells,
	get_draft_item_details,
	get_editor_context,
	get_item_details,
	is_retained_cell,
	set_items_from_editor,
)

GROUPING = "yrp.stock.save_stock_items"
ITEMS = "yrp.yrp.doctype.yrp_item.yrp_item"
EDITOR = "mgk_yrp.stock.item_editor"
MODES = (
	("po", "MGK Purchase Order", {}),
	("dc", "MGK Delivery Challan", {}),
	("dc_return", "MGK Delivery Challan", {"is_return": 1}),
	("grn_po", "MGK Goods Received Note", {"against_purchase_order": 1}),
	("grn_job", "MGK Goods Received Note", {}),
)


class EditorDocument(SimpleNamespace):
	def get(self, key):
		return getattr(self, key, None)

	def set(self, key, value):
		if key == "items":
			value = [EditorRow(row) for row in value]
		setattr(self, key, value)


class EditorRow(frappe._dict):
	def set(self, key, value):
		self[key] = value

	def is_new(self):
		return not self.name


def make_row(item="Plain", **values):
	return EditorRow(
		{
			"item": item,
			"qty": 2,
			"rate": 10,
			"uom": "Bag",
			"stock_uom": "Kg",
			"conversion_factor": 50,
			"purchase_order_item": f"po-{item}",
			"against_dc_item": f"dc-{item}",
			"idx": 1,
			**values,
		}
	)


def make_document(doctype="MGK Purchase Order", **values):
	return EditorDocument(
		**{
			"doctype": doctype,
			"name": "draft-1",
			"is_new": lambda: False,
			"docstatus": 0,
			"is_return": 0,
			"against_purchase_order": 0,
			"purchase_order": "PO-1",
			"item_details": None,
			"items": [make_row()],
			**values,
		}
	)


def attribute_details(item):
	if item == "Sized":
		return {"attributes": [], "primary_attribute": "Size", "primary_attribute_values": ["S", "M", "L"]}
	return {"attributes": [], "primary_attribute_values": []}


def variant_attributes(item):
	if item.startswith("Sized-"):
		return [frappe._dict(attribute="Size", attribute_value=item.split("-")[1])]
	return []


def validation_error(message, *args, **kwargs):
	raise frappe.ValidationError(message)


def child_meta(doctype):
	name = doctype.lower().replace(" ", "_")
	path = Path(__file__).parents[1] / "mgk_yrp" / "doctype" / name / f"{name}.json"
	fields = {field["fieldname"]: frappe._dict(field) for field in json.loads(path.read_text())["fields"]}
	fields["received_type"] = frappe._dict(fieldtype="Link")
	return SimpleNamespace(get_field=fields.get)


class TestItemEditor(TestCase):
	"""Exercise real YRP grouping with only master-data reads replaced."""

	def setUp(self):
		self.stack = ExitStack()
		self.addCleanup(self.stack.close)
		self.mock("frappe.get_hooks", return_value=[])
		self.mock("frappe.get_meta", side_effect=child_meta)
		self.stored_names = self.mock("frappe.get_all", return_value=[])
		self.mock("mgk_yrp.stock.dimensions.get_stock_dimensions", return_value=[])
		self.mock("yrp.stock.dimensions.get_stock_dimensions", return_value=[])
		self.mock("frappe.throw", side_effect=validation_error)
		self.mock("frappe._", side_effect=lambda text: text)
		self.mock("frappe.get_system_settings", return_value=None)
		for module in (
			MGKPurchaseOrder.__module__,
			MGKGoodsReceivedNote.__module__,
			MGKDeliveryChallan.__module__,
			"mgk_yrp.stock.uom",
		):
			self.mock(f"{module}._", side_effect=lambda text: text)
		self.mock(f"{GROUPING}.get_dimension_fieldnames", return_value=[])
		self.mock(f"{EDITOR}.get_dimension_fieldnames", return_value=[])
		self.mock(
			f"{GROUPING}._get_parent_items", side_effect=lambda codes: {c: c.split("-")[0] for c in codes}
		)
		self.mock(f"{GROUPING}._stock_variant_reader", return_value=variant_attributes)
		self.mock(f"{GROUPING}._attribute_value", side_effect=lambda value: value)
		self.mock(f"{ITEMS}.get_attribute_details", side_effect=attribute_details)
		self.resolve = self.mock(
			f"{GROUPING}._resolve_or_create_variant",
			side_effect=lambda item, attrs: f"{item}-{attrs['Size']}" if attrs else item,
		)
		self.source = EditorDocument(
			items=[make_row("Sized-S", name="po-Sized-S", qty=10, received_qty=2, pending_qty=8)],
			check_permission=Mock(),
		)
		self.mock("frappe.get_doc", return_value=self.source)
		self.mock(f"{EDITOR}._po_excess_percentage", return_value=10)

	def mock(self, path, **kwargs):
		return self.stack.enter_context(patch(path, **kwargs))

	def round_trip(self, doc):
		self.stored_names.return_value = [row.name for row in doc.items if row.name]
		doc.item_details = json.dumps(get_item_details(doc))
		set_items_from_editor(doc)
		return doc.items

	def test_round_trip_each_mode_sized_and_plain(self):
		for mode, doctype, header in MODES:
			with self.subTest(mode=mode):
				rows = [
					make_row("Sized-S", row_index="0", table_index=0, name="saved-S"),
					make_row("Sized-M", row_index="0", table_index=0, rate=25, name="saved-M"),
					make_row(row_index="1", table_index=1, name="saved-plain"),
				]
				doc = make_document(doctype, items=rows, **header)
				actual = self.round_trip(doc)
				self.assertEqual([row["item"] for row in actual], [row.item for row in rows])
				for before, after in zip(rows, actual, strict=True):
					for key in ("name", "qty", "rate", "uom", "stock_uom", "conversion_factor"):
						self.assertEqual(after[key], before[key], key)
				self.assertEqual([row.name for row in self.round_trip(doc)], [row.name for row in rows])

	def test_round_trip_splits_one_item_by_dimensions_in_each_mode(self):
		self.mock(f"{GROUPING}.get_dimension_fieldnames", return_value=["received_type"])
		self.mock(f"{EDITOR}.get_dimension_fieldnames", return_value=["received_type"])
		for mode, doctype, header in MODES:
			with self.subTest(mode=mode):
				rows = [
					make_row(
						"Sized-S",
						name=f"saved-{value}",
						row_index="0",
						received_type=value,
						purchase_order_item=f"po-{value}",
						against_dc_item=f"dc-{value}",
					)
					for value in ("Rejected", "Accepted")
				]
				doc = make_document(doctype, items=rows, **header)
				groups = get_item_details(doc)
				self.assertEqual(len(groups[0]["items"]), 2)
				actual = self.round_trip(doc)
				self.assertEqual([row.received_type for row in actual], ["Accepted", "Rejected"])
				self.assertEqual({row.name for row in actual}, {row.name for row in rows})
				self.assertEqual(
					[row.name for row in actual], [f"saved-{row.received_type}" for row in actual]
				)
				link = {"dc_return": "against_dc_item", "grn_po": "purchase_order_item"}.get(mode)
				if link:
					self.assertEqual(
						{row.received_type: row[link] for row in actual},
						{row.received_type: row[link] for row in rows},
					)
				for row in rows:
					row.update(name=f"new-{row.name}", __islocal=1)
				doc = make_document(doctype, items=rows, **header)
				copied = self.round_trip(doc)
				self.assertEqual([row.received_type for row in copied], ["Accepted", "Rejected"])
				self.assertTrue(all(not row.get("name") for row in copied))

	def test_per_cell_source_links_survive(self):
		for mode, doctype, header in (MODES[2], MODES[3]):
			with self.subTest(mode=mode):
				rows = [make_row(f"Sized-{size}", row_index="0") for size in ("S", "M")]
				doc = make_document(doctype, items=rows, **header)
				actual = self.round_trip(doc)
				field = "against_dc_item" if mode == "dc_return" else "purchase_order_item"
				self.assertEqual([row[field] for row in actual], [row[field] for row in rows])
				doc.items = [EditorRow(row) for row in actual]
				again = self.round_trip(doc)
				self.assertEqual([row[field] for row in again], [row[field] for row in rows])
				entries = get_item_details(doc)[0]["items"]
				self.assertEqual(len(entries), 1)
				self.assertEqual(
					[entries[0]["values"][size][field] for size in ("S", "M")], [row[field] for row in rows]
				)

	def test_amend_and_duplicate_hydrate_and_save_copied_rows_each_mode(self):
		for operation in ("amend", "duplicate"):
			for mode, doctype, header in MODES:
				with self.subTest(operation=operation, mode=mode), ExitStack() as stack:
					rows = [
						make_row(
							f"Sized-{size}",
							name=f"new-{operation}-{size}",
							__islocal=1,
							row_index="0",
							table_index=0,
						)
						for size in ("S", "M")
					]
					rows.append(make_row(name=f"new-{operation}-plain", row_index="1", table_index=1))
					rows[1].qty = 0 if mode == "grn_po" else 6
					payload = dict(doctype=doctype, docstatus=0, __islocal=1, items=rows, **header)
					if operation == "amend":
						payload["amended_from"] = "cancelled-source"
					doc = make_document(**payload, is_new=lambda: True)
					get_doc = stack.enter_context(
						patch(
							"frappe.get_doc",
							side_effect=lambda data, *args: doc if isinstance(data, dict) else self.source,
						)
					)
					permission = stack.enter_context(patch("frappe.has_permission"))
					groups = get_draft_item_details(json.dumps(payload))
					get_doc.assert_any_call(payload)
					permission.assert_called_once_with(doctype, "create", doc=doc, throw=True)
					self.assertEqual(len(groups[0]["items"]), 1)
					self.assertTrue(all(not cell.get("name") for cell in get_cells(groups)))
					self.assertTrue(all(row.name.startswith("new-") for row in rows))
					doc.item_details, doc.items = json.dumps(groups), []
					set_items_from_editor(doc)
					for before, after in zip(rows, doc.items, strict=True):
						self.assertIsNone(after.name)
						for field in ("item", "qty", "rate", "uom", "stock_uom", "conversion_factor"):
							self.assertEqual(after[field], before[field], field)
					link = {"grn_po": "purchase_order_item", "dc_return": "against_dc_item"}.get(mode)
					if link:
						self.assertEqual([row[link] for row in doc.items], [row[link] for row in rows])
					self.assertIsNone(doc.item_details)

	def test_editor_payload_drops_local_names_and_preserves_persisted_names_each_mode(self):
		for mode, doctype, header in MODES:
			for identity in (
				{"name": "new-mgk-child-temp"},
				{"name": "copiedhash", "__islocal": 1},
				{"name": "51heb7m1a7", "__islocal": 0},
			):
				for submitting in (False, True):
					with self.subTest(mode=mode, identity=identity, submitting=submitting):
						doc = make_document(doctype, **header)
						groups = get_item_details(doc)
						cell = groups[0]["items"][0]["values"]["default"]
						cell.update(identity)
						self.stored_names.return_value = ["51heb7m1a7"]
						cell.update(purchase_order_item="new-source-po", against_dc_item="new-source-dc")
						doc.item_details = groups
						if submitting:
							doc.docstatus, doc._action = 1, "submit"
						set_items_from_editor(doc)
						self.assertEqual(len(doc.items), 1)
						expected = "51heb7m1a7" if identity["name"] == "51heb7m1a7" else None
						self.assertEqual(doc.items[0].name, expected)
						self.assertEqual(cell["name"], identity["name"])
						link = {"grn_po": "purchase_order_item", "dc_return": "against_dc_item"}.get(mode)
						if link:
							self.assertEqual(doc.items[0][link], cell[link])

	def test_editor_rejects_foreign_names_even_when_in_request_items_each_mode(self):
		for mode, doctype, header in MODES:
			for new_document in (False, True):
				with self.subTest(mode=mode, new_document=new_document):
					self.stored_names.reset_mock()
					self.stored_names.return_value = ["owned-row"]
					doc = make_document(
						doctype,
						items=[make_row(name="foreign-posted-row")],
						is_new=lambda: new_document,
						**header,
					)
					doc.item_details = get_item_details(doc)
					rows, details = doc.items, doc.item_details
					self.resolve.reset_mock()
					with self.assertRaisesRegex(frappe.ValidationError, "does not belong to this document"):
						set_items_from_editor(doc)
					self.assertIs(doc.items, rows)
					self.assertIs(doc.item_details, details)
					self.resolve.assert_not_called()
					if new_document:
						self.stored_names.assert_not_called()
					else:
						self.stored_names.assert_called_once_with(
							f"{doctype} Item",
							filters={"parent": doc.name, "parenttype": doctype, "parentfield": "items"},
							pluck="name",
						)

	def test_editor_rejects_duplicate_owned_names_across_entries_each_mode(self):
		for mode, doctype, header in MODES:
			with self.subTest(mode=mode):
				self.stored_names.return_value = ["owned-row"]
				doc = make_document(doctype, items=[make_row(name="owned-row")], **header)
				groups = get_item_details(doc)
				groups[0]["items"].append(json.loads(json.dumps(groups[0]["items"][0])))
				doc.item_details = groups
				self.resolve.reset_mock()
				with self.assertRaisesRegex(frappe.ValidationError, "Duplicate item editor row"):
					set_items_from_editor(doc)
				self.resolve.assert_not_called()

	def test_hydration_drops_local_flag_name_without_mutating_child_document(self):
		row = Mock()
		row.as_dict.return_value = dict(make_row(name="copiedhash", __islocal=1))
		doc = make_document(items=[row])
		cell = get_item_details(doc)[0]["items"][0]["values"]["default"]
		self.assertFalse(cell.get("name"))
		self.assertEqual(row.as_dict.return_value["name"], "copiedhash")

	def test_draft_hydration_requires_create_or_write_permission(self):
		for is_new, permission in ((True, "create"), (False, "write")):
			with (
				self.subTest(is_new=is_new),
				patch("frappe.get_doc", return_value=make_document(is_new=lambda: is_new)) as get_doc,
				patch("frappe.has_permission", side_effect=frappe.PermissionError) as check_permission,
				patch(f"{EDITOR}.get_item_details") as grouping,
			):
				with self.assertRaises(frappe.PermissionError):
					get_draft_item_details({"doctype": "MGK Purchase Order", "docstatus": 0})
				check_permission.assert_called_once_with(
					"MGK Purchase Order", permission, doc=get_doc.return_value, throw=True
				)
				grouping.assert_not_called()

	def test_draft_hydration_rejects_unsupported_or_submitted_documents(self):
		for doctype, status in (("Item", 0), ("MGK Purchase Order", 1), ("MGK Delivery Challan", 2)):
			with self.subTest(doctype=doctype, status=status), patch("frappe.get_doc") as get_doc:
				with self.assertRaisesRegex(frappe.ValidationError, "draft MGK document"):
					get_draft_item_details({"doctype": doctype, "docstatus": status})
				get_doc.assert_not_called()

	def test_draft_hydration_requires_source_po_read_permission(self):
		doc = make_document("MGK Goods Received Note", against_purchase_order=1, is_new=lambda: True)
		self.source.check_permission.side_effect = frappe.PermissionError
		with (
			patch("frappe.get_doc", side_effect=[doc, self.source]),
			patch("frappe.has_permission"),
			self.assertRaises(frappe.PermissionError),
		):
			get_draft_item_details({"doctype": doc.doctype, "docstatus": 0})
		self.source.check_permission.assert_called_once_with("read")

	def test_cell_retention_keeps_linked_zero_and_invalid_positive_cells(self):
		for cell, link, expected in (
			(None, None, False),
			({}, None, False),
			({"qty": 0}, None, True),
			({"qty": 0}, "purchase_order_item", False),
			({"qty": 0, "purchase_order_item": "source"}, "purchase_order_item", True),
			({"qty": 0, "against_dc_item": "source"}, "against_dc_item", True),
			({"qty": 2}, "purchase_order_item", True),
			({"qty": -2}, "against_dc_item", True),
		):
			with self.subTest(cell=cell, link=link):
				self.assertIs(is_retained_cell(cell, link), expected)

	def test_return_mapping_preserves_sized_source_entry_after_reload(self):
		rows = [
			make_row(
				f"Sized-{size}",
				name=f"dc-{size}",
				qty=qty,
				stock_qty=qty * 50,
				table_index=1,
				row_index="3",
			)
			for size, qty in (("S", 4), ("M", 6))
		]
		source = make_document(
			"MGK Delivery Challan",
			name="DC-1",
			docstatus=1,
			items=rows,
			from_location="Owner",
			to_location="Supplier",
			from_warehouse="Main",
			to_warehouse="Job",
			process_name="Dyeing",
			check_permission=Mock(),
			validate_open=Mock(),
			get_returned_stock_qty=lambda: {row.name: 0 for row in rows},
		)
		target = make_document("MGK Delivery Challan", items=[])
		target.update = lambda values: target.__dict__.update(values)
		target.set_onload = Mock()
		target.set_row_values = lambda: MGKDeliveryChallan.set_row_values(target)

		def append(field, values):
			row = EditorRow(values)
			getattr(target, field).append(row)
			return row

		target.append = append
		with (
			patch("frappe.has_permission"),
			patch(f"{MGKDeliveryChallan.__module__}.lock_documents"),
			patch("mgk_yrp.stock.transit._", side_effect=lambda message: message),
			patch("frappe.get_doc", return_value=source),
			patch("frappe.new_doc", return_value=target),
			patch(f"{MGKDeliveryChallan.__module__}.apply_posting_datetime"),
		):
			self.assertIs(make_return_delivery_challan(source.name), target)
		self.assertEqual([(row.table_index, row.row_index) for row in target.items], [(1, "3"), (1, "3")])
		mapped = target.set_onload.call_args.args[1]
		self.round_trip(target)
		for groups in (mapped, get_item_details(target)):
			self.assertEqual(len(groups[0]["items"]), 1)
			values = groups[0]["items"][0]["values"]
			self.assertEqual(
				[(values[size]["qty"], values[size]["against_dc_item"]) for size in ("S", "M")],
				[(4, "dc-S"), (6, "dc-M")],
			)

	def test_null_and_missing_cells_do_not_create_rows(self):
		for mode, doctype, header in MODES:
			for empty in (None, "missing"):
				with self.subTest(mode=mode, empty=empty):
					doc = make_document(
						doctype, items=[make_row("Sized-S", qty=0 if mode == "grn_po" else 4)], **header
					)
					groups = get_item_details(doc)
					values = groups[0]["items"][0]["values"]
					for size in ("M", "L"):
						if empty is None:
							values[size] = None
						else:
							values.pop(size)
					self.resolve.reset_mock()
					doc.item_details = json.dumps(groups)
					set_items_from_editor(doc)
					self.assertEqual([row.item for row in doc.items], ["Sized-S"])
					self.assertEqual(doc.items[0].qty, 0 if mode == "grn_po" else 4)
					self.resolve.assert_called_once_with("Sized", {"Size": "S"})

	def test_empty_cell_maps_do_not_create_zero_grn_rows(self):
		for values in ({"S": None, "M": None, "L": None}, {"default": None}, {}):
			with self.subTest(values=values):
				doc = make_document("MGK Goods Received Note", against_purchase_order=1)
				groups = get_item_details(doc)
				groups[0]["items"][0]["values"] = values
				doc.item_details = json.dumps(groups)
				set_items_from_editor(doc)
				self.assertEqual(doc.items, [])
		self.resolve.assert_not_called()

	def test_editor_payload_consumed_before_later_python_edits(self):
		doc = make_document()
		self.round_trip(doc)
		self.assertIsNone(doc.item_details)
		doc.items[0]["qty"] = 9
		set_items_from_editor(doc)
		self.assertEqual(doc.items[0]["qty"], 9)

	def test_empty_details_leave_items_untouched(self):
		for details in (None, "", []):
			doc = make_document(item_details=details)
			rows = doc.items
			set_items_from_editor(doc)
			self.assertIs(doc.items, rows)

	def test_submitted_and_cancelled_ignore_editor_payload(self):
		for mode, doctype, header in MODES:
			for status, action in ((1, None), (1, "update_after_submit"), (2, "cancel"), (2, "submit")):
				with self.subTest(mode=mode, status=status, action=action):
					doc = make_document(doctype, **header)
					details = json.dumps(get_item_details(doc))
					doc.docstatus, doc._action, doc.item_details = status, action, details
					rows = doc.items
					set_items_from_editor(doc)
					self.assertIs(doc.items, rows)
					self.assertEqual(doc.item_details, details)

	def test_submit_transition_rebuilds_editor_rows_for_each_mode(self):
		controllers = {
			"MGK Purchase Order": MGKPurchaseOrder,
			"MGK Delivery Challan": MGKDeliveryChallan,
			"MGK Goods Received Note": MGKGoodsReceivedNote,
		}
		for mode, doctype, header in MODES:
			for save_first in (False, True):
				with self.subTest(mode=mode, save_first=save_first), ExitStack() as stack:
					controller = controllers[doctype]
					stack.enter_context(patch(f"{controller.__module__}.prepare_row_dimensions"))
					stack.enter_context(patch(f"{controller.__module__}.apply_posting_datetime", create=True))
					doc = make_document(doctype, items=[make_row("Sized-S"), make_row()], **header)
					if save_first:
						self.round_trip(doc)
					# Desk validates the draft, clears its rows, then sends Submit.
					doc.item_details = json.dumps(get_item_details(doc))
					doc.items, doc.docstatus, doc._action = [], 1, "submit"
					controller.before_validate(doc)
					self.assertEqual([row.item for row in doc.items], ["Sized-S", "Plain"])
					self.assertEqual([row.qty for row in doc.items], [2, 2])
					self.assertIsNone(doc.item_details)

	def test_explicit_empty_editor_clears_rows(self):
		doc = make_document(item_details="[]")
		set_items_from_editor(doc)
		self.assertEqual(doc.items, [])

	def test_onload_and_before_validate_use_editor_for_each_doctype(self):
		for controller, doctype in (
			(MGKPurchaseOrder, "MGK Purchase Order"),
			(MGKDeliveryChallan, "MGK Delivery Challan"),
			(MGKGoodsReceivedNote, "MGK Goods Received Note"),
		):
			with self.subTest(doctype=doctype), ExitStack() as stack:
				doc = make_document(doctype, items=[make_row(qty=5)])
				grouped = get_item_details(doc)
				doc.set_onload = Mock()
				controller.onload(doc)
				doc.set_onload.assert_called_once_with("item_details", grouped)
				doc.item_details = json.dumps(grouped)
				doc.items = []
				stack.enter_context(patch(f"{controller.__module__}.prepare_row_dimensions"))
				stack.enter_context(patch(f"{controller.__module__}.apply_posting_datetime", create=True))
				controller.before_validate(doc)
				self.assertEqual(doc.items[0]["qty"], 5)

	def test_grn_pending_and_allowed_are_per_cell(self):
		doc = make_document("MGK Goods Received Note", against_purchase_order=1, items=[make_row("Sized-S")])
		cell = get_item_details(doc)[0]["items"][0]["values"]["S"]
		self.assertEqual((cell["pending_qty"], cell["allowed_qty"]), (8, 9))
		self.source.check_permission.assert_called_once_with("read")

	def test_po_picker_context_has_per_cell_links_pending_and_allowed(self):
		self.source.doctype = "MGK Purchase Order"
		with patch(f"{EDITOR}.get_dimension_defaults", return_value={"received_type": "Accepted"}):
			context = get_editor_context("PO-1")
		self.assertEqual(context["defaults"], {"received_type": "Accepted"})
		entry = context["po_entries"][0]
		self.assertEqual(entry["name"], "Sized")
		cell = entry["values"]["S"]
		self.assertEqual(cell["purchase_order_item"], "po-Sized-S")
		self.assertNotIn("name", cell)
		self.assertEqual((cell["pending_qty"], cell["allowed_qty"]), (8, 9))

	def test_grn_draft_keeps_zero_without_creating_padded_variants(self):
		doc = make_document(
			"MGK Goods Received Note",
			against_purchase_order=1,
			items=[make_row("Sized-S", qty=0, row_index="0"), make_row("Sized-M", row_index="0")],
		)
		rows = self.round_trip(doc)
		self.assertEqual([(row["item"], row["qty"]) for row in rows], [("Sized-S", 0), ("Sized-M", 2)])
		self.assertEqual(self.resolve.call_count, 2)

	def test_grn_zero_rows_dropped_at_submit(self):
		doc = make_document("MGK Goods Received Note", items=[make_row(qty=0), make_row(qty=3)])
		drop_zero_qty_rows(doc)
		self.assertEqual(len(doc.items), 2)
		doc.docstatus = 1
		drop_zero_qty_rows(doc)
		self.assertEqual([row.qty for row in doc.items], [3])

	def test_grn_before_validate_drops_zero_before_stock_posting(self):
		doc = make_document(
			"MGK Goods Received Note",
			against_purchase_order=1,
			warehouse="Main",
			name="GRN-1",
			posting_date="2026-10-29",
			posting_time="10:00:00",
			items=[make_row("Sized-S", qty=0, row_index="0"), make_row("Sized-M", qty=3, row_index="0")],
		)
		doc.item_details = json.dumps(get_item_details(doc))
		doc.items, doc.docstatus, doc._action = [], 1, "submit"
		doc.validate_row_rate = lambda row: MGKGoodsReceivedNote.validate_row_rate(doc, row)
		with (
			patch(f"{MGKGoodsReceivedNote.__module__}.prepare_row_dimensions"),
			patch(f"{MGKGoodsReceivedNote.__module__}.apply_posting_datetime"),
			patch("mgk_yrp.stock.ledger.get_dimension_fieldnames", return_value=[]),
		):
			MGKGoodsReceivedNote.before_validate(doc)
			self.assertEqual([(row.item, row.qty) for row in doc.items], [("Sized-M", 3)])
			MGKGoodsReceivedNote.set_row_values(doc)
			entries = MGKGoodsReceivedNote.get_stock_entries(doc)
		self.assertEqual([entry["qty"] for entry in entries], [150])
		self.assertEqual([entry["warehouse"] for entry in entries], ["Main"])

	def test_grn_cannot_submit_only_zero_rows(self):
		doc = make_document("MGK Goods Received Note", docstatus=1, items=[make_row(qty=0)])
		with self.assertRaisesRegex(frappe.ValidationError, "positive quantity"):
			drop_zero_qty_rows(doc)

	def test_po_nonpositive_rate_still_throws_after_sync(self):
		for rate in (0, -1):
			doc = make_document(items=[make_row(rate=rate)])
			doc.items = [EditorRow(row) for row in self.round_trip(doc)]
			with self.assertRaisesRegex(frappe.ValidationError, "greater than zero"):
				MGKPurchaseOrder.set_item_values(doc)

	def test_grn_foreign_po_row_still_throws_after_sync(self):
		doc = make_document("MGK Goods Received Note", against_purchase_order=1)
		doc.items = [EditorRow(row) for row in self.round_trip(doc)]
		with self.assertRaisesRegex(frappe.ValidationError, "map to a row"):
			MGKGoodsReceivedNote.set_purchase_order_rows(doc, self.source)

	def test_grn_missing_po_link_with_quantity_still_throws_after_sync(self):
		doc = make_document(
			"MGK Goods Received Note",
			against_purchase_order=1,
			items=[make_row(purchase_order_item="")],
		)
		doc.items = [EditorRow(row) for row in self.round_trip(doc)]
		with self.assertRaisesRegex(frappe.ValidationError, "Expected exactly one Purchase Order row"):
			MGKGoodsReceivedNote.set_purchase_order_rows(doc, self.source)

	def test_grn_uom_mismatch_still_throws_after_sync(self):
		doc = make_document(
			"MGK Goods Received Note",
			against_purchase_order=1,
			items=[make_row("Sized-S", uom="Nos")],
		)
		doc.items = [EditorRow(row) for row in self.round_trip(doc)]
		with self.assertRaisesRegex(frappe.ValidationError, "different uom"):
			MGKGoodsReceivedNote.set_purchase_order_rows(doc, self.source)

	def test_job_work_zero_rate_retains_zero_valuation(self):
		doc = make_document("MGK Goods Received Note", items=[make_row(rate=0)])
		row = EditorRow(self.round_trip(doc)[0])
		MGKGoodsReceivedNote.validate_row_rate(doc, row)
		self.assertEqual(row.allow_zero_valuation_rate, 1)
