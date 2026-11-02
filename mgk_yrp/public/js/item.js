(() => {
	frappe.ui.form.on("Item", {
		setup(frm) {
			frm.set_query("item", "mgk_process_conversions", () => ({
				filters: { variant_of: ["is", "not set"], disabled: 0 },
			}));
			frm.set_query("mgk_default_value", "attributes", (doc, cdt, cdn) => ({
				query: "mgk_yrp.stock.attribute_defaults.search_default_values",
				params: { item: doc.__islocal ? null : doc.name, attribute: locals[cdt][cdn].attribute || "" },
			}));
		},
		stock_uom(frm) {
			return Promise.all((frm.doc.mgk_process_conversions || []).map(row =>
				frappe.model.set_value(row.doctype, row.name, "from_uom", frm.doc.stock_uom)
			));
		},
	});

	frappe.ui.form.on("Item Variant Attribute", {
		attribute(frm, cdt, cdn) {
			if (locals[cdt][cdn].mgk_default_value) {
				return frappe.model.set_value(cdt, cdn, "mgk_default_value", null);
			}
		},
	});

	frappe.ui.form.on("MGK Item Process Conversion", {
		mgk_process_conversions_add(frm, cdt, cdn) {
			const row = locals[cdt][cdn];
			return frappe.model.set_value(cdt, cdn, {
				from_uom: frm.doc.stock_uom,
				from_qty: row.from_qty || 1,
			});
		},
		async item(frm, cdt, cdn) {
			const row = locals[cdt][cdn];
			const item = row.item;
			await frappe.model.set_value(cdt, cdn, "from_uom", frm.doc.stock_uom);
			if (!item) {
				return frappe.model.set_value(cdt, cdn, "to_uom", null);
			}
			const { message } = await frappe.db.get_value("Item", item, "stock_uom");
			if (row.item === item) {
				return frappe.model.set_value(cdt, cdn, "to_uom", message.stock_uom);
			}
		},
	});
})();
