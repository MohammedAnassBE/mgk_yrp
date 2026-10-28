frappe.listview_settings["MGK Delivery Challan"] = {
	add_fields: ["is_return", "close_status"],
	get_indicator(doc) {
		if (doc.is_return) return [__("Return"), "grey", "is_return,=,1"];
		const colors = { Open: "blue", Closed: "green", Reopening: "orange" };
		if (colors[doc.close_status]) {
			return [__(doc.close_status), colors[doc.close_status], `close_status,=,${doc.close_status}`];
		}
	},
};
