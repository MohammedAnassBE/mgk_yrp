from pathlib import Path

import frappe
import frappe.sessions

from mgk_yrp.web.boot import get_boot

no_cache = 1
ASSET_BASE = "/assets/mgk_yrp/frontend/assets/"


def resolve_frontend_assets():
	assets = Path(__file__).resolve().parents[1] / "public" / "frontend" / "assets"
	javascript = sorted(assets.glob("mgkyrp-*.js"))
	stylesheets = sorted(assets.glob("index-*.css"))
	return (
		ASSET_BASE + javascript[0].name if javascript else None,
		ASSET_BASE + stylesheets[0].name if stylesheets else None,
	)


def get_context(context):
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/web"
		raise frappe.Redirect
	context.csrf_token = frappe.sessions.get_csrf_token()
	frappe.db.commit()
	context.boot = get_boot()
	context.frontend_js, context.frontend_css = resolve_frontend_assets()
	context.no_cache = 1
	context.no_header = 1
	context.no_sidebar = 1
	context.no_breadcrumbs = 1
	return context
