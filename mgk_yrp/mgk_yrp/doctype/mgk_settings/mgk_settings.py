import re

import frappe
from frappe import _
from frappe.model.document import Document


class MGKSettings(Document):
	def validate(self):
		self.company_gstin = (self.company_gstin or "").strip().upper()
		if not re.fullmatch(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]", self.company_gstin):
			frappe.throw(_("Company GSTIN must be a valid 15-character GSTIN."))
		self.company_state_code = self.company_gstin[:2]
		self.validate_default_warehouse()

	def validate_default_warehouse(self):
		if not self.default_warehouse:
			return
		if not self.default_location:
			frappe.throw(_("Set MGK Location before Default Warehouse."))
		warehouse = frappe.db.get_value(
			"Warehouse", self.default_warehouse, ["supplier", "disabled", "is_group"], as_dict=True
		)
		if warehouse.supplier != self.default_location:
			frappe.throw(
				_("Default Warehouse {0} must belong to MGK Location {1}.").format(
					self.default_warehouse, self.default_location
				)
			)
		if warehouse.disabled or warehouse.is_group:
			frappe.throw(_("Default Warehouse {0} must be an enabled, non-group warehouse.").format(self.default_warehouse))
