frappe.ui.form.on("MGK Settings", {
	setup(frm) {
		frm.set_query("default_warehouse", () => ({
			filters: { supplier: frm.doc.default_location || "", disabled: 0, is_group: 0 },
		}));
	},
	default_location(frm) {
		frm.set_value("default_warehouse", null);
	},
});
