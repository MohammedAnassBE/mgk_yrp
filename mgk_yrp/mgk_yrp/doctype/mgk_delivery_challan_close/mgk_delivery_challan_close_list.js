frappe.listview_settings["MGK Delivery Challan Close"] = {
	add_fields: ["reopen_status"],
	has_indicator_for_cancelled: true,
	get_indicator(doc) {
		if (doc.reopen_status === "Reversing") {
			return [__("Reversing"), "orange", "reopen_status,=,Reversing"];
		}
		if (doc.reopen_status === "Reopened") {
			return [__("Reopened"), "grey", "reopen_status,=,Reopened"];
		}
		if (doc.docstatus === 2) return [__("Cancelled"), "red", "docstatus,=,2"];
	},
};
