import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt

from mgk_yrp.job_work.grn_from_dc import validate_template_rows
from mgk_yrp.job_work.process_plan import get_editable_challan, set_plan_link
from mgk_yrp.stock.dimensions import prepare_row_dimensions
from mgk_yrp.stock.item_editor import get_item_details, set_items_from_editor
from mgk_yrp.stock.uom import apply_independent_uom


class MGKProcessPlanning(Document):
	def onload(self):
		self.set_onload("item_details", get_item_details(self))

	def load_doc_before_save(self, *, raise_exception=False):
		if not self.is_new():
			self.get_challan()
		super().load_doc_before_save(raise_exception=raise_exception)

	def before_validate(self):
		self.get_challan()
		set_items_from_editor(self)
		prepare_row_dimensions(self)

	def validate(self):
		challan = self.get_challan()
		if self.name != self.delivery_challan:
			frappe.throw(_("Process Planning must be named after its Delivery Challan."))
		self.supplier = challan.to_location
		self.process_name = challan.process_name
		prepare_row_dimensions(self)
		for row in self.items:
			if flt(row.qty) <= 0:
				frappe.throw(_("Row {0}: Quantity must be positive.").format(row.idx))
			apply_independent_uom(row)
		validate_template_rows(self.items, [challan], challan.process_name)

	def get_challan(self):
		if not self.is_new() and self.delivery_challan != self.name:
			frappe.throw(_("Process Planning Delivery Challan cannot be changed."))
		return get_editable_challan(self.delivery_challan)

	def on_update(self):
		set_plan_link(self.get_challan(), self.name)

	def on_trash(self):
		challan = self.get_challan()
		if challan.mgk_process_planning == self.name:
			set_plan_link(challan, None)
