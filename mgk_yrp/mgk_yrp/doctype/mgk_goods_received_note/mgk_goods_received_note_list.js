frappe.listview_settings["MGK Goods Received Note"] = {
	add_fields: ["purchase_invoice", "is_internal_transfer", "transfer_status", "warehouse"],
	onload(listview) {
		if (frappe.model.can_create("MGK Delivery Challan")) {
			listview.page?.add_actions_menu_item(__("Create DC"), () => frappe.mgk_yrp.dispatch_selection(listview));
		}
		if (!frappe.model.can_read("MGK Purchase Invoice")) return;
		const get_fields = listview.get_fields.bind(listview);
		listview.get_fields = () => get_fields().concat(
			"purchase_invoice.docstatus as purchase_invoice_docstatus"
		);
	},
	get_indicator(doc) {
		const transfer = frappe.mgk_yrp.transfer_indicator(doc);
		if (transfer) return transfer;
		const filter = doc.purchase_invoice
			? `purchase_invoice,=,${doc.purchase_invoice}` : "purchase_invoice,is,not set";
		if (doc.purchase_invoice && doc.purchase_invoice_docstatus === 1) {
			return [__("Billed"), "green", filter];
		}
		if (doc.purchase_invoice && doc.purchase_invoice_docstatus == null) {
			return [__("Invoice Linked"), "orange", filter];
		}
		return [__("To Bill"), "orange", filter];
	},
};
