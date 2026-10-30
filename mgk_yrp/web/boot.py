import json
import logging

import frappe
import frappe.defaults

WEB_DOCTYPES = (
	"MGK Purchase Order",
	"MGK Goods Received Note",
	"MGK Delivery Challan",
	"MGK Delivery Challan Close",
	"MGK Purchase Invoice",
	"MGK Agent",
	"Item",
	"Supplier",
	"Warehouse",
	"YRP Process",
	"YRP Received Type",
	"Address",
	"Contact",
	"User",
	"YRP Stock Ledger Entry",
)
PERMISSION_TYPES = ("read", "create", "write", "submit", "cancel", "delete", "amend")
logger = logging.getLogger(__name__)


def apply_accurate_web_perms(user):
	for permission_type in PERMISSION_TYPES:
		key = f"can_{permission_type}"
		allowed = set(user.get(key) or []) - set(WEB_DOCTYPES)
		allowed.update(
			doctype for doctype in WEB_DOCTYPES if frappe.has_permission(doctype, permission_type)
		)
		user[key] = sorted(allowed)
	return user


def get_ui_config():
	try:
		from yrp.yrp.api.ui_config import get_config_for_boot

		return get_config_for_boot()
	except Exception:
		logger.exception("/web: UI config boot resolution failed; using the default home layout")
		return None


def get_boot():
	user = json.loads(frappe.as_json(frappe.get_user().load_user()))
	defaults = frappe.defaults.get_defaults()
	user["defaults"] = defaults
	user["user_permissions"] = frappe.defaults.get_user_permissions()
	return {
		"site_name": frappe.local.site,
		"socketio_port": frappe.conf.socketio_port or 9000,
		"dev_server": bool(frappe._dev_server),
		"user": apply_accurate_web_perms(user),
		"ui_config": get_ui_config(),
		"defaults": defaults,
		"sysdefaults": {**defaults, "rounding_method": frappe.get_system_settings("rounding_method")},
	}
