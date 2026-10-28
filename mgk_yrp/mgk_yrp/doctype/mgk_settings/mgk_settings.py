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
