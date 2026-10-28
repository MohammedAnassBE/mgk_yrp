frappe.listview_settings["MGK Goods Received Note"] = {
	add_fields: ["purchase_invoice"],
	onload(listview) {
		if (!frappe.model.can_read("MGK Purchase Invoice")) return;
		const get_fields = listview.get_fields.bind(listview);
		listview.get_fields = () => get_fields().concat(
			"purchase_invoice.docstatus as purchase_invoice_docstatus"
		);
	},
	get_indicator(doc) {
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
