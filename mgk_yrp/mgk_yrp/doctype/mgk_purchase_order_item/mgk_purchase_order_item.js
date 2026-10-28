async function update_order_row(frm, child_doctype, child_name) {
	const row = locals[child_doctype][child_name];
	await frappe.model.set_value(child_doctype, child_name, {
		amount: flt(row.qty) * flt(row.rate),
		stock_qty: flt(row.qty) * flt(row.conversion_factor),
	});
	await update_order_totals(frm);
}

frappe.ui.form.on("MGK Purchase Order Item", {
	async item(frm, child_doctype, child_name) {
		const row = locals[child_doctype][child_name];
		const item = row.item;
		const { message } = item ? await frappe.call({
			method: "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.get_item_uom",
			args: { item },
		}) : { message: { uom: "", stock_uom: "", conversion_factor: 0 } };
		if (row.item !== item) return;
		await frappe.model.set_value(child_doctype, child_name, {
			uom: message.uom, stock_uom: message.stock_uom, conversion_factor: message.conversion_factor,
		});
		await update_order_row(frm, child_doctype, child_name);
	},
	qty: update_order_row,
	rate: update_order_row,
	items_remove: update_order_totals,
});
