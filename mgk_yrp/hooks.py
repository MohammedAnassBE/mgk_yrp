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

fixtures = [
	{"dt": "Custom Field", "filters": [["module", "=", "MGK YRP"]]},
	{"dt": "Property Setter", "filters": [["module", "=", "MGK YRP"]]},
]

doc_events = {"Item": {"validate": "mgk_yrp.overrides.item.validate"}}

doctype_js = {"MGK Purchase Order": "mgk_yrp/doctype/mgk_purchase_order_item/mgk_purchase_order_item.js"}

scheduler_events = {"cron": {"*/2 * * * *": ["mgk_yrp.job_work.reopen.finish_pending_reopens"]}}
