app_name = "mgk_yrp"
app_title = "MGK"
app_publisher = "Anas"
app_description = "MGK YRP"
app_email = "mohammedanasman123@gmail.com"
app_license = "mit"

app_logo_url = "/assets/mgk_yrp/images/mgk.svg"
app_home = "/desk/mgk"
add_to_apps_screen = [{"name": app_name, "logo": app_logo_url, "title": app_title, "route": app_home}]

required_apps = ["frappe", "erpnext", "yrp"]

website_route_rules = [{"from_route": "/web/<path:app_path>", "to_route": "web"}]

app_include_js = ["mgk_yrp.bundle.js"]

doctype_js = {"Item": "public/js/item.js"}

extend_doctype_class = {"YRP Stock Entry": ["mgk_yrp.overrides.stock_entry.MGKStockEntry"]}

fixtures = [
	{"dt": "Custom Field", "filters": [["module", "=", "MGK YRP"]]},
	{"dt": "Property Setter", "filters": [["module", "=", "MGK YRP"]]},
	{"dt": "Item Group", "filters": [["name", "in", ["Karigan Items", "Salavai Cone Items"]]]},
	{
		"dt": "YRP UI Layout",
		"filters": [["name", "in", ["MGK Workspace", "Stock Users", "Billing", "Purchase", "PO and Bills"]]],
	},
]

after_migrate = ["mgk_yrp.stock.dimension_fields.sync_dimension_fields"]

doc_events = {
	"YRP Stock Valuation Adjustment": {"on_update": "mgk_yrp.web.notify.valuation_updated"},
	"Item": {"validate": "mgk_yrp.overrides.item.validate"},
	"Supplier": {"validate": "mgk_yrp.overrides.supplier.validate"},
	"YRP Stock Settings": {
		"on_update": "mgk_yrp.stock.dimension_fields.sync_dimension_fields",
		"validate": "mgk_yrp.stock.transit.validate_settings",
	},
	"YRP Stock Entry": {
		"validate": [
			"mgk_yrp.stock.transit.validate_completion",
			"mgk_yrp.job_work.dc_from_grn.validate_head_office_move_entry",
		],
		"before_submit": [
			"mgk_yrp.stock.transit.validate_completion",
			"mgk_yrp.job_work.dc_from_grn.validate_head_office_move_entry",
		],
		"on_submit": [
			"mgk_yrp.stock.transit.completion_submitted",
			"mgk_yrp.job_work.dc_from_grn.head_office_move_submitted",
		],
		"before_cancel": [
			"mgk_yrp.stock.transit.before_completion_cancel",
			"mgk_yrp.job_work.dc_from_grn.validate_head_office_move_cancel",
		],
		"on_cancel": "mgk_yrp.stock.transit.update_completion",
	},
}

after_job = ["mgk_yrp.web.notify.valuation_job_finished"]

scheduler_events = {"cron": {"*/2 * * * *": ["mgk_yrp.job_work.reopen.finish_pending_reopens"]}}
