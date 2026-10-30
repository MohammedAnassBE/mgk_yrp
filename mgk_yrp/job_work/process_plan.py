import frappe
from frappe import _

from mgk_yrp.stock import transit
from mgk_yrp.stock.item_editor import get_item_details, set_items_from_editor
from mgk_yrp.stock.locking import lock_documents

PLAN_DOCTYPE = "MGK Process Planning"


def set_plan_link(challan, name):
	challan.flags.mgk_updating_process_plan = True
	try:
		challan.mgk_process_planning = name
		challan.save(ignore_permissions=True)
	finally:
		challan.flags.mgk_updating_process_plan = False


@frappe.whitelist()
def get_process_plan(delivery_challan):
	challan = frappe.get_doc("MGK Delivery Challan", delivery_challan)
	challan.check_permission("read")
	if not frappe.db.exists(PLAN_DOCTYPE, challan.name):
		frappe.has_permission(PLAN_DOCTYPE, "read", throw=True)
		return []
	plan = frappe.get_doc(PLAN_DOCTYPE, challan.name)
	plan.check_permission("read")
	return get_item_details(plan)


@frappe.whitelist()
def save_process_plan(delivery_challan, item_details):
	challan = get_editable_challan(delivery_challan)
	exists = frappe.db.exists(PLAN_DOCTYPE, challan.name)
	plan = frappe.get_doc(PLAN_DOCTYPE, challan.name) if exists else frappe.new_doc(PLAN_DOCTYPE)
	plan.check_permission("write" if exists else "create")
	plan.item_details = item_details if isinstance(item_details, str) else frappe.as_json(item_details)
	set_items_from_editor(plan)
	if not plan.items:
		if exists:
			plan.check_permission("delete")
			frappe.delete_doc(PLAN_DOCTYPE, plan.name)
		return None
	plan.delivery_challan = challan.name
	plan.item_details = None
	plan.save()
	return plan.name


def get_editable_challan(delivery_challan):
	lock_documents({"MGK Delivery Challan": [delivery_challan], PLAN_DOCTYPE: [delivery_challan]})
	challan = frappe.get_doc("MGK Delivery Challan", delivery_challan, for_update=True)
	challan.check_permission("read")
	if challan.docstatus != 1 or challan.is_return:
		frappe.throw(_("Only submitted, non-return Delivery Challans can have a process plan."))
	transit.reject_internal_action(challan, _("update the plan"))
	challan.validate_open(_("update the plan"))
	return challan
