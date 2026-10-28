frappe.ui.form.on("MGK Goods Received Note", {
	setup(frm) {
		frm.set_query("purchase_order", () => ({
			filters: { docstatus: 1, status: ["in", ["To Receive", "Partially Received"]] },
		}));
		frm.set_query("delivery_challans", () => ({
			filters: {
				docstatus: 1, is_return: 0, close_status: "Open", to_location: frm.doc.supplier || "",
			},
		}));
	},
	refresh(frm) {
		frm.ignore_doctypes_on_cancel_all = [
			"MGK Purchase Invoice", "MGK Delivery Challan Close", "YRP Stock Ledger Entry",
			"YRP Repost Item Valuation", "YRP Stock Valuation Adjustment", "YRP Stock Valuation Production Link",
		];
		set_purchase_order_fields(frm);
	},
	supplier(frm) {
		frm.clear_table("delivery_challans");
		frm.refresh_field("delivery_challans");
	},
	against_purchase_order(frm) {
		set_purchase_order_fields(frm);
		frm.clear_table("items");
		frm.clear_table("delivery_challans");
		frm.refresh_fields();
		return frm.set_value({ purchase_order: "", total_qty: 0, total_amount: 0 });
	},
	async purchase_order(frm) {
		if (!frm.doc.against_purchase_order || !frm.doc.purchase_order) return;
		const source_name = frm.doc.purchase_order;
		const { message } = await frappe.call({
			method: "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.make_goods_received_note",
			args: { source_name },
		});
		if (frm.doc.purchase_order !== source_name || !frm.doc.against_purchase_order) return;
		frm.clear_table("items");
		for (const row of message.items || []) {
			const values = {};
			for (const field of ["item", "qty", "uom", "stock_uom", "conversion_factor", "stock_qty",
				"rate", "stock_rate", "amount", "purchase_order_item"]) values[field] = row[field];
			frm.add_child("items", values);
		}
		await frm.set_value({
			supplier: message.supplier, delivery_location: message.delivery_location,
			warehouse: message.warehouse, total_qty: message.total_qty, total_amount: message.total_amount,
		});
		frm.refresh_field("items");
	},
});

function set_purchase_order_fields(frm) {
	const against_order = Boolean(frm.doc.against_purchase_order);
	for (const field of ["supplier", "delivery_location"]) frm.set_df_property(field, "read_only", against_order);
	const grid = frm.fields_dict.items.grid;
	grid.update_docfield_property("rate", "read_only", against_order);
	grid.update_docfield_property("item", "read_only", against_order);
	grid.cannot_add_rows = against_order;
	grid.refresh();
}

frappe.ui.form.on("MGK Goods Received Note Item", {
	qty(frm, cdt, cdn) {
		return update_receipt_row(frm, cdt, cdn);
	},
	rate(frm, cdt, cdn) {
		return update_receipt_row(frm, cdt, cdn);
	},
	items_remove(frm) {
		update_receipt_totals(frm);
	},
});

async function update_receipt_row(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	await frappe.model.set_value(cdt, cdn, {
		stock_qty: flt(row.qty) * flt(row.conversion_factor),
		stock_rate: flt(row.conversion_factor) > 0 ? flt(row.rate) / flt(row.conversion_factor) : 0,
		amount: flt(row.qty) * flt(row.rate),
	});
	return update_receipt_totals(frm);
}

function update_receipt_totals(frm) {
	const rows = frm.doc.items || [];
	return frm.set_value({
		total_qty: rows.reduce((total, row) => total + flt(row.qty), 0),
		total_amount: rows.reduce((total, row) => total + flt(row.qty) * flt(row.rate), 0),
	});
}
