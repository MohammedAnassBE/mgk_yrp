import frappe

from mgk_yrp.job_work.dc_from_grn import lock_head_office_move_sources


class MGKStockEntry:
	def load_doc_before_save(self, *, raise_exception=False):
		if not self.is_new() and self.docstatus == 2:
			previous = frappe.get_doc(self.doctype, self.name)
			lock_head_office_move_sources(self, previous)
		super().load_doc_before_save(raise_exception=raise_exception)
