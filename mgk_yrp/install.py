import frappe

ROOT_ITEM_GROUP = "All Item Groups"
ITEM_GROUPS = ("Karigan Items", "Salavai Cone Items")


def ensure_item_groups():
	"""Create the PO item groups, and their root when the ERPNext setup wizard has not run."""
	if not frappe.db.exists("Item Group", ROOT_ITEM_GROUP):
		frappe.get_doc({"doctype": "Item Group", "item_group_name": ROOT_ITEM_GROUP, "is_group": 1}).insert(
			ignore_permissions=True
		)
	for name in ITEM_GROUPS:
		if not frappe.db.exists("Item Group", name):
			frappe.get_doc(
				{"doctype": "Item Group", "item_group_name": name, "parent_item_group": ROOT_ITEM_GROUP}
			).insert(ignore_permissions=True)
