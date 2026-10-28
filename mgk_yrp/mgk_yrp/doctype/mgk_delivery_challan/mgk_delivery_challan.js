frappe.ui.form.on("MGK Delivery Challan", {
	setup(frm) {
		for (const fieldname of ["from_location", "to_location"]) {
			frm.set_query(fieldname, () => ({ filters: { disabled: 0 } }));
		}
		for (const fieldname of ["from_warehouse", "to_warehouse"]) {
			frm.set_query(fieldname, () => ({ filters: { disabled: 0, is_group: 0 } }));
		}
	},
	refresh(frm) {
		frm.ignore_doctypes_on_cancel_all = [
			"MGK Delivery Challan", "MGK Goods Received Note", "MGK Delivery Challan Close",
			"YRP Stock Ledger Entry", "YRP Repost Item Valuation", "YRP Stock Valuation Adjustment",
			"YRP Stock Valuation Production Link",
		];
		const grid = frm.fields_dict.items.grid;
		grid.update_docfield_property("item", "read_only", Boolean(frm.doc.is_return));
		grid.cannot_add_rows = Boolean(frm.doc.is_return);
		grid.refresh();
		if (frm.doc.docstatus === 1 && !frm.doc.is_return && frm.doc.close_status === "Open") {
			if (frappe.model.can_create("MGK Delivery Challan")) {
				frm.add_custom_button(__("Return"), () => frappe.model.open_mapped_doc({
					method: "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan.make_return_delivery_challan",
					frm,
				}));
			}
			if (frappe.model.can_create("MGK Delivery Challan Close")) {
				frm.add_custom_button(__("Close"), () => frappe.model.open_mapped_doc({
					method: "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan.make_delivery_challan_close",
					frm,
				}));
			}
		}
		if (frm.doc.delivery_challan_close) {
			frm.add_custom_button(__("View Close"), () =>
				frappe.set_route("Form", "MGK Delivery Challan Close", frm.doc.delivery_challan_close));
		}
		mgk_delivery_stock_hints(frm);
	},
	from_location(frm) {
		return mgk_delivery_warehouse(frm, "from");
	},
	to_location(frm) {
		return mgk_delivery_warehouse(frm, "to");
	},
	from_warehouse(frm) {
		mgk_delivery_stock_hints(frm);
	},
	posting_date(frm) {
		mgk_delivery_stock_hints(frm);
	},
	posting_time(frm) {
		mgk_delivery_stock_hints(frm);
	},
});

async function mgk_delivery_warehouse(frm, side) {
	if (frm.doc.is_return) return;
	const supplier = frm.doc[`${side}_location`];
	await frm.set_value(`${side}_warehouse`, null);
	if (!supplier) return;
	const warehouses = await frappe.db.get_list("Warehouse", {
		filters: { supplier, disabled: 0 }, fields: ["name"], limit: 2,
	});
	if (frm.doc[`${side}_location`] === supplier && warehouses.length === 1) {
		await frm.set_value(`${side}_warehouse`, warehouses[0].name);
	}
}

function mgk_delivery_totals(frm) {
	let quantity = 0;
	let value = 0;
	for (const row of frm.doc.items || []) {
		row.amount = flt(row.qty) * flt(row.rate);
		quantity += flt(row.qty);
		value += row.amount;
	}
	frm.set_value("total_qty", quantity);
	frm.set_value("total_declared_value", value);
	frm.refresh_field("items");
}

function mgk_delivery_stock_hints(frm) {
	if (!frm.doc.from_warehouse) return;
	for (const row of frm.doc.items || []) mgk_delivery_stock_hint(frm, row);
}

async function mgk_delivery_stock_hint(frm, row) {
	if (!row.item || !frm.doc.from_warehouse) return;
	const args = {
		item: row.item, warehouse: frm.doc.from_warehouse,
		posting_date: frm.doc.posting_date, posting_time: frm.doc.posting_time,
	};
	const response = await frappe.call({ method: "yrp.stock.api.get_stock_balance", args });
	if (row.item !== args.item || frm.doc.from_warehouse !== args.warehouse) return;
	const grid_row = frm.fields_dict.items.grid.grid_rows_by_docname[row.name];
	if (grid_row) {
		grid_row.set_field_property("qty", "description",
			__("Available stock quantity: {0}", [flt(response.message)]));
	}
}

frappe.ui.form.on("MGK Delivery Challan Item", {
	item(frm, cdt, cdn) {
		mgk_delivery_stock_hint(frm, locals[cdt][cdn]);
	},
	qty: mgk_delivery_totals,
	rate: mgk_delivery_totals,
	items_remove: mgk_delivery_totals,
	form_render(frm, cdt, cdn) {
		mgk_delivery_stock_hint(frm, locals[cdt][cdn]);
	},
});
