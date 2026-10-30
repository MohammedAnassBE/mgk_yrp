import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime
from yrp.stock.stock_ledger import enqueue_voucher_repost
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment import (
	VALUE_TOLERANCE,
	create_adjustment,
	is_stock_adjustment_enabled,
	register_production_links,
)

from mgk_yrp.job_work.close_valuation import (
	build_allocations_and_links,
	build_consumption_entries,
	get_dc_item_values,
	get_linked_outputs,
	lock_close_buckets,
	validate_outputs,
)
from mgk_yrp.job_work.dependencies import lock_close_submission
from mgk_yrp.job_work.reopen import lock_reopen, start_reopen, validate_reopen
from mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note import get_linking_grns
from mgk_yrp.stock.ledger import post_stock_entries, validate_stock_dimensions


class MGKDeliveryChallanClose(Document):
	def onload(self):
		if self.stock_valuation_adjustment:
			self.set_onload(
				"valuation_status",
				frappe.db.get_value(
					"YRP Stock Valuation Adjustment", self.stock_valuation_adjustment, "status"
				),
			)

	def load_doc_before_save(self, *, raise_exception=False):
		if not self.is_new():
			previous = frappe.get_doc(self.doctype, self.name)
			if self.docstatus == 2:
				lock_reopen(previous)
			else:
				self.lock_sources(previous.delivery_challan)
		super().load_doc_before_save(raise_exception=raise_exception)

	def lock_sources(self, previous=None):
		return lock_close_submission(self, previous)

	def get_open_challan(self):
		challan = frappe.get_doc("MGK Delivery Challan", self.delivery_challan, for_update=True)
		challan.check_permission("read")
		if challan.docstatus != 1 or challan.is_return:
			frappe.throw(_("Only submitted, non-return Delivery Challans can be closed."))
		challan.validate_open(_("close"))
		return challan

	def validate(self):
		if self.docstatus < 2:
			self.lock_sources()
			self.refresh_preview(self.get_open_challan())

	@frappe.whitelist()
	def preview(self):
		self.check_permission("write")
		self.validate()

	def refresh_preview(self, challan):
		validate_stock_dimensions()
		lock_close_buckets(challan)
		posting = now_datetime()
		self.posting_date, self.posting_time = posting.date(), posting.time()
		self.supplier, self.warehouse = challan.to_location, challan.to_warehouse
		self.set("items", get_dc_item_values(challan))
		self.set("outputs", get_linked_outputs(challan.name))
		validate_outputs(challan, self.outputs)
		self.set_preview_totals()
		self.total_value_gap = 0
		self.stock_valuation_adjustment = None
		self.reopen_status = ""

	def set_preview_totals(self):
		output_items = {row.input_item for row in self.outputs}
		self.total_dc_value = flt(sum(row.own_value for row in self.items), 6)
		self.loss_value = flt(sum(row.own_value for row in self.items if row.item not in output_items), 6)
		self.total_output_qty = sum(row.stock_qty for row in self.outputs)
		units = {row.stock_uom for row in self.outputs}
		self.output_stock_uom = next(iter(units)) if len(units) == 1 else None
		allocated = self.total_dc_value - self.loss_value
		self.value_per_unit = flt(allocated / self.total_output_qty, 6) if self.output_stock_uom else 0

	def before_submit(self):
		self.lock_sources()
		challan = self.get_open_challan()
		if frappe.db.exists(self.doctype, {"delivery_challan": challan.name, "docstatus": 1}):
			frappe.throw(_("This Delivery Challan already has a submitted Close."))
		drafts = get_linking_grns(challan.name, (0,), for_update=True)
		if drafts:
			frappe.throw(
				_("Draft GRN {0} links this Delivery Challan; submit or remove it before closing.").format(
					drafts[0]
				)
			)
		self.refresh_preview(challan)
		if self.outputs and not is_stock_adjustment_enabled():
			frappe.throw(_("Enable Apply Stock Adjustment in YRP Settings to close with linked outputs."))

	def on_submit(self):
		result = post_stock_entries(self.get_stock_entries())
		self.record_consumption(result)
		allocations, links = build_allocations_and_links(self)
		if links:
			self.create_valuation(allocations, links)
		self.persist_audit()
		frappe.db.set_value(
			"MGK Delivery Challan",
			self.delivery_challan,
			{
				"close_status": "Closed",
				"delivery_challan_close": self.name,
			},
		)
		enqueue_voucher_repost(self)
		frappe.get_doc("MGK Delivery Challan", self.delivery_challan).notify_update()

	def get_stock_entries(self) -> list[dict]:
		return build_consumption_entries(self, self.items)

	def record_consumption(self, result):
		for row in self.items:
			if row.remaining_stock_qty <= 0:
				continue
			detail = result["entries"].get(f"close:{row.name}")
			if not detail:
				frappe.throw(_("Missing consumption ledger entry for Close row {0}.").format(row.idx))
			row.consumption_sle = detail["sle"]
			row.consumed_value = flt(detail["value"], 6)
			row.value_gap = flt(row.consumed_value - row.own_value, 6)
		self.total_value_gap = flt(sum(flt(row.value_gap) for row in self.items), 6)

	def create_valuation(self, allocations, links):
		register_production_links(self.doctype, self.name, links)
		count = frappe.db.count(
			"YRP Stock Valuation Production Link",
			{
				"source_doctype": self.doctype,
				"source_name": self.name,
				"active": 1,
			},
		)
		if count != len(links):
			frappe.throw(_("Incomplete production valuation links for this Close."))
		self.stock_valuation_adjustment = create_adjustment(
			adjustment_type="Delivery Challan Close",
			source_doctype=self.doctype,
			source_name=self.name,
			effective_date=self.posting_date,
			allocations=allocations,
		)
		if not self.stock_valuation_adjustment and any(
			abs(flt(row["difference"])) > VALUE_TOLERANCE for row in allocations
		):
			frappe.throw(_("Close did not create its Stock Valuation Adjustment."))

	def persist_audit(self):
		self.db_update()
		for row in [*self.items, *self.outputs]:
			row.db_update()

	def before_cancel(self):
		self.flags.for_update = True
		self.reload()
		self.docstatus = 2
		validate_reopen(self)
		self.ignore_linked_doctypes = (
			"MGK Delivery Challan",
			"YRP Stock Ledger Entry",
			"YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment",
			"YRP Stock Valuation Production Link",
		)

	def on_cancel(self):
		start_reopen(self)
