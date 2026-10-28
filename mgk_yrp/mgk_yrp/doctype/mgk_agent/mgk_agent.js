frappe.ui.form.on("MGK Agent", {
	refresh(frm) {
		frappe.dynamic_link = { doc: frm.doc, fieldname: "name", doctype: "MGK Agent" };
		if (frm.doc.__islocal) {
			hide_field(["address_html", "contact_html"]);
			frappe.contacts.clear_address_and_contact(frm);
		} else {
			unhide_field(["address_html", "contact_html"]);
			frappe.contacts.render_address_and_contact(frm);
		}
	},
});
