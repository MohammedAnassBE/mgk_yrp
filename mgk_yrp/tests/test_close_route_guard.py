from unittest.mock import patch

import frappe

from mgk_yrp.tests.close_fixtures import CloseTestCase
from mgk_yrp.tests.fixtures import close_dc, make_job_work_grn, set_process_outputs

RECEIPT = "mgk_yrp.mgk_yrp.doctype.mgk_goods_received_note.mgk_goods_received_note"


class TestCloseRouteGuard(CloseTestCase):
	def test_close_rejects_preexisting_cyclic_receipts(self):
		set_process_outputs(self.raw_item, self.process_name, [(self.raw_item, 1, 1)])
		for warehouse in (self.main, self.destination):
			with self.subTest(warehouse=warehouse):
				self.make_input()
				challan = self.make_challan()
				with patch(f"{RECEIPT}.validate_output_route"):
					receipt = make_job_work_grn(
						supplier=self.supplier, warehouse=warehouse,
						items=[{"item": self.raw_item, "qty": 1, "rate": 1}],
						delivery_challans=[challan.name],
					)
				self.assertEqual(receipt.docstatus, 1)
				with self.assertRaisesRegex(frappe.ValidationError, "Cyclic route"):
					close_dc(challan)
				self.assertTrue(challan.reload().is_open)
