frappe.listview_settings["MGK Purchase Order"] = {
	add_fields: ["status"],
	has_indicator_for_draft: true,
	has_indicator_for_cancelled: true,
	get_indicator(doc) {
		const colors = {
			Draft: "red", "To Receive": "orange", "Partially Received": "yellow",
			Completed: "green", Cancelled: "grey",
		};
		return [__(doc.status), colors[doc.status], `status,=,${doc.status}`];
	},
};
