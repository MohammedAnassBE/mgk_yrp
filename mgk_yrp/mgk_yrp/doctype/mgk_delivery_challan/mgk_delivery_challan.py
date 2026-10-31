from collections import defaultdict

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt
from yrp.stock.stock_ledger import enqueue_voucher_repost
from yrp.stock.utils import apply_posting_datetime

from mgk_yrp.job_work import dc_from_grn
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import get_linking_grns
from mgk_yrp.stock import transit
from mgk_yrp.stock.backdating import validate_backdated_cancel, validate_backdated_posting
from mgk_yrp.stock.dimensions import (
	copy_row_dimensions,
	prepare_row_dimensions,
	validate_return_dimensions,
)
from mgk_yrp.stock.item_editor import get_item_details, set_items_from_editor
from mgk_yrp.stock.ledger import (
	assert_transfer_pairs,
	post_stock_entries,
	transfer_entries,
	validate_stock_dimensions,
)
from mgk_yrp.stock.locking import lock_documents
from mgk_yrp.stock.uom import (
	apply_independent_uom,
	copy_uom_snapshot,
	has_uom_snapshot,
	validate_uom_snapshot,
)
from mgk_yrp.stock.warehouse import get_supplier_warehouse


class MGKDeliveryChallan(Document):
	def before_insert(self):
		self.mgk_process_planning = None

	def onload(self):
		self.set_onload("item_details", get_item_details(self))

	def before_update_after_submit(self):
		if self.mgk_process_planning and self.mgk_process_planning != self.name:
			frappe.throw(_("Process Planning must belong to this Delivery Challan."))
		previous = self.get_doc_before_save()
		if previous and self.mgk_process_planning != previous.mgk_process_planning and not self.flags.mgk_updating_process_plan:
			frappe.throw(_("Process Planning is maintained by Update Plan and cannot be changed here."))

	def load_doc_before_save(self, *, raise_exception=False):
		"""Lock source and return names before Frappe locks this challan."""
		if not self.is_new():
			previous = frappe.get_doc(self.doctype, self.name)
			if self.docstatus == 1 and previous.docstatus == 0:
				dc_from_grn.lock_submission_sources(self, previous)
			self.lock_sources(previous=previous)
		super().load_doc_before_save(raise_exception=raise_exception)

	def before_validate(self):
		set_items_from_editor(self)
		prepare_row_dimensions(self)
		apply_posting_datetime(self)

	def validate(self):
		self.before_update_after_submit()
		if bool(cint(self.is_return)) != bool(self.return_against):
			frappe.throw(_("A Return must specify Return Against; other Delivery Challans cannot."))
		self.set_warehouses()
		transit.set_internal_transfer(self)
		receipt = self.validate_purchase_receipt()
		if self.is_return:
			self.set_return_rows(self.get_return_source())
		elif receipt:
			self.set_purchase_receipt_rows(receipt)
		else:
			for row in self.items:
				if row.against_dc_item:
					frappe.throw(_("Only return rows can reference a Delivery Challan item."))
				if not row.goods_received_note_item:
					apply_independent_uom(row)
		self.set_goods_received_note_rows()
		self.set_row_values()
		if self.docstatus == 0:
			self.close_status = ""
			self.delivery_challan_close = None

	def validate_purchase_receipt(self, *, for_update=False):
		if not self.purchase_order and not self.goods_received_note:
			return None
		if self.is_return or not self.purchase_order or not self.goods_received_note:
			frappe.throw(
				_("Purchase Order and Goods Received Note must both be set on a non-return Delivery Challan.")
			)
		receipt = frappe.get_doc("MGK Goods Received Note", self.goods_received_note, for_update=for_update)
		receipt.check_permission("read")
		frappe.get_doc("MGK Purchase Order", self.purchase_order).check_permission("read")
		if receipt.docstatus != 1:
			frappe.throw(_("Goods Received Note {0} must be submitted.").format(receipt.name))
		transit.reject_internal_action(receipt, _("create a receipt-linked Delivery Challan"))
		if not receipt.against_purchase_order or receipt.purchase_order != self.purchase_order:
			frappe.throw(
				_("Goods Received Note {0} must be against Purchase Order {1}.").format(
					receipt.name, self.purchase_order
				)
			)
		if receipt.warehouse != self.from_warehouse:
			frappe.throw(_("From Warehouse must match Goods Received Note {0}.").format(receipt.name))
		return receipt

	def set_purchase_receipt_rows(self, receipt):
		if len(self.items) != len(receipt.items):
			frappe.throw(_("Delivery Challan rows must match the Goods Received Note."))
		for row, source in zip(self.items, receipt.items, strict=True):
			if row.goods_received_note_item and row.goods_received_note_item != source.name:
				frappe.throw(_("Row {0}: Item must map to a row of this Goods Received Note.").format(row.idx))
			if row.goods_received_note and row.goods_received_note != receipt.name:
				frappe.throw(_("Row {0}: Goods Received Note must match the header.").format(row.idx))
			row.goods_received_note = receipt.name
			row.goods_received_note_item = source.name
			if row.item != source.item or flt(row.qty) != flt(source.qty) or row.against_dc_item:
				frappe.throw(
					_("Row {0}: Item and quantity must match the Goods Received Note.").format(row.idx)
				)
			validate_return_dimensions(row, source, source_label="Goods Received Note")
			if row.is_new() and not has_uom_snapshot(row):
				copy_uom_snapshot(row, source)
			validate_uom_snapshot(row, source, _("Goods Received Note"))
			copy_uom_snapshot(row, source)

	def set_goods_received_note_rows(self):
		if not dc_from_grn.get_receipt_names(self):
			if any(row.goods_received_note_item for row in self.items):
				frappe.throw(_("Goods Received Note is required for receipt-linked rows."))
			return
		if self.is_return:
			frappe.throw(_("Return rows cannot reference a Goods Received Note."))
		self.lock_sources()
		for row in self.items:
			if not row.goods_received_note and not row.goods_received_note_item:
				continue
			receipt = dc_from_grn.get_source_receipt(row)
			source = next((item for item in receipt.items if item.name == row.goods_received_note_item), None)
			if not source or source.item != row.item:
				frappe.throw(_("Row {0}: Item must map to a row of this Goods Received Note.").format(row.idx))
			validate_return_dimensions(row, source, source_label="Goods Received Note")
			if row.is_new() and not has_uom_snapshot(row):
				copy_uom_snapshot(row, source)
			validate_uom_snapshot(row, source, _("Goods Received Note"))
			copy_uom_snapshot(row, source)

	def set_warehouses(self):
		if not self.to_warehouse:
			self.to_warehouse = get_supplier_warehouse(self.to_location)
		if self.from_warehouse and self.from_warehouse == self.to_warehouse:
			frappe.throw(_("From Warehouse and To Warehouse must be different."))

	@property
	def is_open(self) -> bool:
		return self.close_status == "Open"

	def validate_open(self, action: str) -> None:
		transit.reject_internal_action(self, action)
		if not self.is_open:
			frappe.throw(
				_("Delivery Challan {0} is {1}; cannot {2}.").format(self.name, self.close_status, action)
			)

	def get_return_source(self, *, for_update=False):
		source = frappe.get_doc("MGK Delivery Challan", self.return_against, for_update=for_update)
		source.check_permission("read")
		if source.docstatus != 1 or source.is_return:
			frappe.throw(_("Return Against must be a submitted, non-return Delivery Challan."))
		transit.validate_return_source(source)
		self.validate_return_header(source)
		return source

	def validate_return_header(self, source):
		fields = {
			"from_location": source.to_location,
			"from_warehouse": transit.get_return_warehouse(source),
			"to_location": source.from_location,
			"to_warehouse": source.from_warehouse,
			"process_name": source.process_name,
		}
		for fieldname, expected in fields.items():
			if self.get(fieldname) != expected:
				frappe.throw(_("Return {0} must mirror the original Delivery Challan.").format(fieldname))

	def set_return_rows(self, source):
		source_rows = {row.name: row for row in source.items}
		for row in self.items:
			original = source_rows.get(row.against_dc_item)
			if not original or original.item != row.item:
				frappe.throw(_("Row {0}: Item must map to a row of this Delivery Challan.").format(row.idx))
			if row.is_new() and not has_uom_snapshot(row):
				copy_uom_snapshot(row, original)
			validate_uom_snapshot(row, original, _("Delivery Challan"))
			validate_return_dimensions(row, original)
			copy_uom_snapshot(row, original)

	def set_row_values(self):
		for row in self.items:
			if flt(row.qty) <= 0 or flt(row.conversion_factor) <= 0:
				frappe.throw(_("Row {0}: Quantity and Conversion Factor must be positive.").format(row.idx))
			if flt(row.rate) < 0:
				frappe.throw(_("Row {0}: Declared Rate cannot be negative.").format(row.idx))
			row.stock_qty = flt(row.qty) * flt(row.conversion_factor)
			row.amount = flt(row.qty) * flt(row.rate)
			row.returned_qty = 0
		self.total_qty = sum(flt(row.qty) for row in self.items)
		self.total_declared_value = sum(flt(row.amount) for row in self.items)

	def lock_sources(self, *, previous=None):
		previous = previous or self.get_doc_before_save()
		documents = {
			"MGK Delivery Challan": [
				self.return_against,
				previous.return_against if previous else None,
				self.name,
			],
		}
		for doctype, fieldname in (
			("MGK Purchase Order", "purchase_order"),
			("MGK Goods Received Note", "goods_received_note"),
		):
			names = [getattr(self, fieldname), getattr(previous, fieldname) if previous else None]
			if any(names):
				documents[doctype] = names
		receipts = set(dc_from_grn.get_receipt_names(self))
		if previous:
			receipts.update(dc_from_grn.get_receipt_names(previous))
		if receipts:
			documents["MGK Goods Received Note"] = sorted(receipts)
			challans = dc_from_grn.get_linking_challans(receipts)
			documents["MGK Delivery Challan"].extend(challans)
		moves = dc_from_grn.get_head_office_moves([self.name]) if self.docstatus == 2 else []
		if moves:
			documents["YRP Stock Entry"] = moves
		lock_documents(documents)
		if receipts and dc_from_grn.get_linking_challans(receipts, for_update=True) != challans:
			frappe.throw(_("Stock dependencies changed; retry the operation."))
		if self.docstatus == 2 and dc_from_grn.get_head_office_moves([self.name], for_update=True) != moves:
			frappe.throw(_("Stock dependencies changed; retry the operation."))

	def before_submit(self):
		validate_stock_dimensions()
		dc_from_grn.lock_submission_sources(self)
		self.lock_sources()
		transit.prepare_submission(self)
		receipt = self.validate_purchase_receipt(for_update=True)
		if receipt:
			self.set_purchase_receipt_rows(receipt)
			self.set_row_values()
		self.set_goods_received_note_rows()
		dc_from_grn.validate_dispatch_allowance(self)
		dc_from_grn.validate_head_office_move(self)
		if self.is_return:
			source = self.get_return_source(for_update=True)
			self.set_return_rows(source)
			self.set_row_values()
			self.validate_return_allowance(source)
		buckets = [(entry["item"], entry["warehouse"]) for entry in self.get_stock_entries()]
		validate_backdated_posting(self, buckets)

	def validate_return_allowance(self, source):
		pending = transit.get_pending_quantities(source)
		requested = defaultdict(float)
		for row in self.items:
			requested[row.against_dc_item] += flt(row.qty)
		for row in source.items:
			if flt(requested[row.name] - pending[row.name], 6) > 0:
				frappe.throw(_("Row {0}: Return exceeds the remaining delivered quantity.").format(row.idx))

	def get_returned_stock_qty(self) -> dict[str, float]:
		rows = frappe.db.sql(
			"""
			SELECT item.against_dc_item, item.stock_qty
			FROM `tabMGK Delivery Challan Item` item
			JOIN `tabMGK Delivery Challan` dc ON dc.name = item.parent
			WHERE dc.return_against = %s AND dc.is_return = 1 AND dc.docstatus = 1
			ORDER BY dc.name, item.name FOR UPDATE
			""",
			(self.name,),
		)
		returned = defaultdict(float)
		for name, quantity in rows:
			returned[name] += flt(quantity)
		return returned

	def update_returned_qty(self):
		returned = self.get_returned_stock_qty()
		for row in self.items:
			row.db_set("returned_qty", returned[row.name], update_modified=False)
		transit.update_transfer_status(self)
		self.notify_update()

	def get_stock_entries(self) -> list[dict]:
		return [
			entry
			for row in self.items
			for entry in transfer_entries(
				self, row, from_warehouse=self.from_warehouse, to_warehouse=transit.get_receiving_warehouse(self)
			)
		]

	def on_submit(self):
		entries = self.get_stock_entries()
		post_stock_entries(entries)
		assert_transfer_pairs(self.doctype, self.name, expected_entries=entries)
		enqueue_voucher_repost(self)
		if self.is_return:
			self.get_return_source(for_update=True).update_returned_qty()
		elif not self.is_internal_transfer:
			self.db_set("close_status", "Open")
			self.notify_update()

	def before_cancel(self):
		self.lock_sources()
		self.flags.for_update = True
		self.reload()
		self.docstatus = 2
		validate_stock_dimensions()
		if self.is_return:
			self.get_return_source(for_update=True)
		else:
			source = frappe.get_doc(self.doctype, self.name, for_update=True)
			if not source.is_internal_transfer:
				source.validate_open(_("cancel"))
			source.validate_no_dependents()
		if self.is_internal_transfer:
			transit.cancel_completions(self)
		else:
			validate_backdated_cancel(self)
		self.ignore_linked_doctypes = (
			"YRP Stock Ledger Entry",
			"YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment",
			"YRP Stock Valuation Production Link",
			"YRP Stock Entry",
		)

	def validate_no_dependents(self):
		if self.delivery_challan_close:
			frappe.throw(_("Reopen the Delivery Challan Close before cancelling this Delivery Challan."))
		if frappe.db.exists(self.doctype, {"return_against": self.name, "docstatus": ["<", 2]}):
			frappe.throw(
				_("Cancel or delete return Delivery Challans before cancelling this Delivery Challan.")
			)
		links = get_linking_grns(self.name, (0, 1))
		if links:
			frappe.throw(_("Cancel or delete linking Goods Received Note {0} first.").format(links[0]))

	def on_cancel(self):
		post_stock_entries(self.get_stock_entries(), cancel=True)
		dc_from_grn.cancel_head_office_moves(self)
		transit.clear_transfer_status(self)
		enqueue_voucher_repost(self)
		if self.is_return:
			self.get_return_source(for_update=True).update_returned_qty()
		else:
			self.db_set("close_status", "")
			self.notify_update()


@frappe.whitelist()
def make_delivery_challan_close(source_name: str) -> Document:
	frappe.has_permission("MGK Delivery Challan Close", "create", throw=True)
	target = frappe.new_doc("MGK Delivery Challan Close")
	target.delivery_challan = source_name
	target.validate()
	return target


@frappe.whitelist(methods=["POST"])
def close_delivery_challan(source_name: str) -> str:
	"""Create and submit the Close for an open job-work DC in one transaction."""
	close = make_delivery_challan_close(source_name)
	close.insert()
	close.submit()
	return close.name


@frappe.whitelist()
def make_return_delivery_challan(source_name: str) -> Document:
	frappe.has_permission("MGK Delivery Challan", "create", throw=True)
	lock_documents({"MGK Delivery Challan": [source_name]})
	source = frappe.get_doc("MGK Delivery Challan", source_name, for_update=True)
	source.check_permission("read")
	if source.docstatus != 1 or source.is_return:
		frappe.throw(_("Only submitted, non-return Delivery Challans can be returned."))
	transit.validate_return_source(source)
	target = frappe.new_doc("MGK Delivery Challan")
	target.update(
		{
			"is_return": 1,
			"return_against": source.name,
			"from_location": source.to_location,
			"from_warehouse": transit.get_return_warehouse(source),
			"to_location": source.from_location,
			"to_warehouse": source.from_warehouse,
			"process_name": source.process_name,
		}
	)
	pending = transit.get_pending_quantities(source)
	for row in source.items:
		remaining = pending[row.name]
		if flt(remaining, 6) > 0:
			item = target.append(
				"items",
				{
					"item": row.item,
					"against_dc_item": row.name,
					"rate": row.rate,
					"table_index": row.table_index,
					"row_index": row.row_index,
				},
			)
			item.qty = remaining
			copy_uom_snapshot(item, row)
			copy_row_dimensions(row, item)
	if not target.items:
		frappe.throw(_("This Delivery Challan has no remaining quantity to return."))
	apply_posting_datetime(target)
	target.set_row_values()
	target.set_onload("item_details", get_item_details(target))
	return target
