import frappe
from frappe.tests import IntegrationTestCase
from yrp.yrp.doctype.yrp_user_listview.yrp_user_listview import (
	get_user_listview,
	reset_user_listview,
	save_user_listview,
)


class TestWebListview(IntegrationTestCase):
	def test_saved_column_order_reload_reset_and_user_isolation(self):
		original_user = frappe.session.user
		self.addCleanup(frappe.set_user, original_user)
		frappe.set_user("Administrator")
		users = [self.make_user(), self.make_user()]
		frappe.set_user(users[0])
		doctype = "MGK Purchase Order"
		self.assertIsNone(get_user_listview(doctype_name=doctype))
		columns = [
			{"fieldname": "po_date", "enabled": 1},
			{"fieldname": "supplier", "enabled": 1},
			{"fieldname": "total_qty", "enabled": 0},
		]
		self.assertEqual(save_user_listview(doctype_name=doctype, columns=columns), "ok")
		saved = get_user_listview(doctype_name=doctype)
		self.assertEqual(
			[(row.fieldname, row.enabled) for row in saved],
			[("po_date", 1), ("supplier", 1), ("total_qty", 0)],
		)
		frappe.set_user(users[1])
		self.assertIsNone(get_user_listview(doctype_name=doctype))
		frappe.set_user(users[0])
		self.assertEqual(reset_user_listview(doctype_name=doctype), "ok")
		self.assertIsNone(get_user_listview(doctype_name=doctype))

	def make_user(self):
		return frappe.get_doc({
			"doctype": "User",
			"email": f"mgk-list-{frappe.generate_hash(length=10)}@example.test",
			"first_name": "MGK List",
			"send_welcome_email": 0,
			"roles": [{"role": "Purchase User"}],
		}).insert(ignore_permissions=True).name
