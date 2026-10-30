(() => {
	frappe.ui.form.on("Item", {
		stock_uom(frm) {
			return Promise.all((frm.doc.mgk_process_conversions || []).map(row =>
				frappe.model.set_value(row.doctype, row.name, "from_uom", frm.doc.stock_uom)
			));
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
