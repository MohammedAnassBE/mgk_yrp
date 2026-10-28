frappe.listview_settings["MGK Purchase Invoice"] = {
	get_indicator(doc) {
		if (doc.docstatus === 1) return [__("Submitted"), "green", "docstatus,=,1"];
	},
};
