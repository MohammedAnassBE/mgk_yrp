import json
from pathlib import Path
from unittest.mock import Mock, patch

import frappe
from frappe.tests import IntegrationTestCase

from mgk_yrp import hooks
from mgk_yrp.web import boot
from mgk_yrp.www import web

BOOT = "mgk_yrp.web.boot"


class TestWebBoot(IntegrationTestCase):
	def test_recomputes_all_web_permissions_and_preserves_unrelated_doctypes(self):
		user = {f"can_{permission}": [*boot.WEB_DOCTYPES, "Unrelated"] for permission in boot.PERMISSION_TYPES}
		denied = "MGK Purchase Invoice"
		with patch(f"{BOOT}.frappe.has_permission", side_effect=lambda dt, permission: dt != denied) as check:
			result = boot.apply_accurate_web_perms(user)
		for permission in boot.PERMISSION_TYPES:
			self.assertNotIn(denied, result[f"can_{permission}"])
			self.assertIn("MGK Goods Received Note", result[f"can_{permission}"])
			self.assertIn("Unrelated", result[f"can_{permission}"])
		self.assertEqual(check.call_count, len(boot.WEB_DOCTYPES) * len(boot.PERMISSION_TYPES))

	def test_authoritative_permissions_add_missing_access(self):
		with patch(f"{BOOT}.frappe.has_permission", side_effect=lambda dt, permission: permission == "read"):
			user = boot.apply_accurate_web_perms({})
		self.assertEqual(set(user["can_read"]), set(boot.WEB_DOCTYPES))
		self.assertEqual(user["can_create"], [])

	def test_boot_exposes_desk_rounding_method_for_invoice_rate_preview(self):
		loaded_user = Mock(load_user=Mock(return_value={"name": "Administrator"}))
		with (
			patch(f"{BOOT}.frappe.get_user", return_value=loaded_user),
			patch(f"{BOOT}.frappe.has_permission", return_value=True),
			patch(f"{BOOT}.get_ui_config", return_value=None),
			patch(f"{BOOT}.frappe.defaults.get_defaults", return_value={}),
			patch(f"{BOOT}.frappe.defaults.get_user_permissions", return_value={}),
			patch(f"{BOOT}.frappe.get_system_settings", return_value="Banker's Rounding") as settings,
		):
			result = boot.get_boot()
		self.assertEqual(result["sysdefaults"], {"rounding_method": "Banker's Rounding"})
		settings.assert_called_once_with("rounding_method")

	def test_boot_ships_session_defaults_and_link_permissions_like_desk(self):
		defaults = {"company": "Essdee India", "country": "India", "currency": "INR", "user": frappe.session.user}
		permissions = {"Company": [{"doc": "Essdee India", "applicable_for": "Warehouse", "is_default": 1}]}
		loaded_user = Mock(load_user=Mock(return_value={"name": frappe.session.user, "defaults": {"country": "stale"}}))
		with (
			patch(f"{BOOT}.frappe.get_user", return_value=loaded_user),
			patch(f"{BOOT}.frappe.has_permission", return_value=True),
			patch(f"{BOOT}.get_ui_config", return_value=None),
			patch(f"{BOOT}.frappe.defaults.get_defaults", return_value=defaults) as get_defaults,
			patch(f"{BOOT}.frappe.defaults.get_user_permissions", return_value=permissions) as get_permissions,
			patch(f"{BOOT}.frappe.get_system_settings", return_value="Banker's Rounding"),
		):
			result = boot.get_boot()
		get_defaults.assert_called_once_with()
		get_permissions.assert_called_once_with()
		self.assertEqual(result["defaults"], defaults)
		self.assertEqual(result["user"]["defaults"], defaults)
		self.assertEqual(result["user"]["user_permissions"], permissions)
		self.assertEqual(result["sysdefaults"], {**defaults, "rounding_method": "Banker's Rounding"})

	def test_boot_survives_ui_config_failure_and_keeps_connection_settings(self):
		loaded_user = Mock(load_user=Mock(return_value={"name": "Administrator", "can_read": []}))
		with (
			patch(f"{BOOT}.frappe.get_user", return_value=loaded_user),
			patch(f"{BOOT}.frappe.has_permission", return_value=True),
			patch("yrp.yrp.api.ui_config.get_config_for_boot", side_effect=RuntimeError("broken config")),
			self.assertLogs(BOOT, level="ERROR") as logged,
		):
			result = boot.get_boot()
		self.assertIsNone(result["ui_config"])
		self.assertEqual(result["site_name"], frappe.local.site)
		self.assertEqual(result["socketio_port"], frappe.conf.socketio_port or 9000)
		self.assertEqual(result["dev_server"], bool(frappe._dev_server))
		self.assertEqual(result["user"]["name"], "Administrator")
		self.assertIn("broken config", logged.output[0])

	def test_guest_redirects_before_loading_boot(self):
		original_user = frappe.session.user
		self.addCleanup(frappe.set_user, original_user)
		self.addCleanup(frappe.local.flags.pop, "redirect_location", None)
		frappe.set_user("Guest")
		with patch("mgk_yrp.www.web.get_boot") as get_boot, self.assertRaises(frappe.Redirect):
			web.get_context(frappe._dict())
		get_boot.assert_not_called()
		self.assertEqual(frappe.local.flags.redirect_location, "/login?redirect-to=/web")

	def test_assets_use_only_the_entry_prefix_and_global_stylesheet(self):
		assets = [
			Path("mgkyrp-current.js"), Path("index-vendor.js"),
			Path("index-current.css"), Path("OtherPage-current.css"),
		]
		with patch.object(Path, "glob", side_effect=lambda pattern: [p for p in assets if p.match(pattern)]):
			javascript, stylesheet = web.resolve_frontend_assets()
		self.assertEqual(javascript, "/assets/mgk_yrp/frontend/assets/mgkyrp-current.js")
		self.assertEqual(stylesheet, "/assets/mgk_yrp/frontend/assets/index-current.css")
		self.assertIn({"from_route": "/web/<path:app_path>", "to_route": "web"}, hooks.website_route_rules)


class TestWebLayoutResolution(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		original_user = frappe.session.user
		self.addCleanup(frappe.set_user, original_user)
		frappe.set_user("Administrator")
		suffix = frappe.generate_hash(length=10)
		self.user = frappe.get_doc({
			"doctype": "User",
			"email": f"mgk-layout-{suffix}@example.test",
			"first_name": "MGK Layout",
			"send_welcome_email": 0,
			"roles": [{"role": "Stock User"}],
		}).insert(ignore_permissions=True)
		self.blocks = [
			{"id": "dc", "type": "mgk-delivery-challan"},
			{"id": "grn", "type": "mgk-goods-received-note"},
		]
		self.layout = frappe.get_doc({
			"doctype": "YRP UI Layout",
			"layout_name": f"MGK DC+GRN {suffix}",
			"render_mode": "Configurable Layout",
			"config": json.dumps({"schema_version": 1, "screens": {"home": {"blocks": self.blocks}}}),
		}).insert(ignore_permissions=True)
		preference = frappe.db.exists("YRP UI Preference", {"user": self.user.name})
		self.preference = frappe.get_doc("YRP UI Preference", preference) if preference else frappe.new_doc("YRP UI Preference")
		self.preference.update({"user": self.user.name, "layout": self.layout.name, "overrides": "{}"})
		self.preference.save(ignore_permissions=True)

	def test_real_resolver_passes_the_subset_to_boot_without_affecting_administrator(self):
		frappe.set_user(self.user.name)
		resolved = boot.get_boot()["ui_config"]
		self.assertIsNotNone(resolved)
		self.assertEqual(resolved["meta"]["layout"], self.layout.name)
		self.assertEqual(resolved["config"]["screens"]["home"]["blocks"], self.blocks)
		frappe.set_user("Administrator")
		admin = boot.get_boot()["ui_config"]
		self.assertIsNotNone(admin)
		self.assertNotEqual(admin["meta"]["layout"], self.layout.name)

	def test_real_resolver_merges_boolean_hidden_override(self):
		self.preference.overrides = json.dumps({"schema_version": 1, "screens": {"home": {"hidden": {"grn": True}}}})
		self.preference.save(ignore_permissions=True)
		frappe.set_user(self.user.name)
		resolved = boot.get_boot()["ui_config"]
		self.assertIsNotNone(resolved)
		home = resolved["config"]["screens"]["home"]
		self.assertEqual(home["blocks"], self.blocks)
		self.assertEqual(home["hidden"], {"grn": True})
