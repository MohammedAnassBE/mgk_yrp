frappe.listview_settings["MGK Delivery Challan"] = {
	add_fields: ["is_return", "close_status", "is_internal_transfer", "transfer_status"],
	onload(listview) {
		if (frappe.model.can_create("MGK Goods Received Note")) {
			listview.page.add_actions_menu_item(__("Create GRN"), () => frappe.mgk_yrp.create_grn_from_selection(listview));
		}
	},
	get_indicator(doc) {
		const transfer = frappe.mgk_yrp.transfer_indicator(doc);
		if (transfer) return transfer;
		if (doc.is_return) return [__("Return"), "grey", "is_return,=,1"];
		const colors = { Open: "blue", Closed: "green", Reopening: "orange" };
		if (colors[doc.close_status]) {
			return [__(doc.close_status), colors[doc.close_status], `close_status,=,${doc.close_status}`];
		}
	},
};
