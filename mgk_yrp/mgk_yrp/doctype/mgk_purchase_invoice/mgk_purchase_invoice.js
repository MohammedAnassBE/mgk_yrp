const invoice_method = "mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice";

frappe.ui.form.on("MGK Purchase Invoice", {
	setup(frm) {
		frm.set_query("supplier", () => ({ filters: { disabled: 0 } }));
		frm.get_field("items").grid.cannot_add_rows = true;
	},
	refresh(frm) {
		frm.ignore_doctypes_on_cancel_all = [
			"MGK Goods Received Note", "YRP Stock Ledger Entry", "YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment", "YRP Stock Valuation Production Link",
		];
		frm.remove_custom_button(__("Get GRNs"));
		if (frm.doc.docstatus === 0 && frm.doc.supplier && frm.doc.against) {
			frm.add_custom_button(__("Get GRNs"), () => select_invoice_grns(frm));
		}
	},
	against: clear_invoice_rows,
	supplier: clear_invoice_rows,
});

frappe.ui.form.on("MGK Purchase Invoice Item", {
	rate(frm, doctype, name) {
		const row = locals[doctype][name];
		row.amount = flt(flt(row.qty) * flt(row.rate), 2);
		row.cgst_amount = row.sgst_amount = row.igst_amount = 0;
		if (frm.doc.tax_type === "CGST + SGST") {
			row.cgst_amount = row.sgst_amount = flt(row.amount * flt(row.gst_rate) / 200, 2);
		} else if (frm.doc.tax_type === "IGST") {
			row.igst_amount = flt(row.amount * flt(row.gst_rate) / 100, 2);
		}
		frm.refresh_field("items");
		update_invoice_totals(frm);
	},
	items_remove: update_invoice_totals,
});

function clear_invoice_rows(frm) {
	if (frm.doc.docstatus !== 0) return;
	frm.clear_table("items");
	frm.refresh_field("items");
	frm.set_value({ supplier_gstin: "", company_gstin: "", tax_type: "No Tax" });
	update_invoice_totals(frm);
	frm.trigger("refresh");
}

function update_invoice_totals(frm) {
	const rows = frm.doc.items || [];
	const sum = field => rows.reduce((total, row) => total + flt(row[field]), 0);
	const tax = flt(sum("cgst_amount") + sum("sgst_amount") + sum("igst_amount"), 2);
	return frm.set_value({
		total_qty: sum("qty"), net_total: flt(sum("amount"), 2),
		total_cgst: flt(sum("cgst_amount"), 2), total_sgst: flt(sum("sgst_amount"), 2),
		total_igst: flt(sum("igst_amount"), 2), total_tax: tax,
		grand_total: flt(sum("amount") + tax, 2),
	});
}

async function select_invoice_grns(frm) {
	const supplier = frm.doc.supplier;
	const against = frm.doc.against;
	const { message: receipts } = await frappe.call({
		method: `${invoice_method}.get_unbilled_grns`, args: { supplier, against },
	});
	if (supplier !== frm.doc.supplier || against !== frm.doc.against) return;
	if (!receipts.length) return frappe.msgprint(__("No unbilled GRNs for this supplier and type."));
	const dialog = new frappe.ui.Dialog({
		title: __("Get GRNs"), size: "large",
		fields: [{ fieldname: "grns", fieldtype: "MultiCheck", label: __("Unbilled GRNs"),
			options: receipts.map(receipt => ({ value: receipt.name,
				label: `${receipt.name} · ${receipt.posting_date} · ${receipt.total_qty}` })),
		}],
		primary_action_label: __("Fetch"),
		async primary_action(values) {
			if (!values.grns?.length) return;
			const { message: rows } = await frappe.call({
				method: `${invoice_method}.get_grn_rows`, args: { grn_names: values.grns },
			});
			if (supplier !== frm.doc.supplier || against !== frm.doc.against) return dialog.hide();
			frm.clear_table("items");
			rows.forEach(row => frm.add_child("items", row));
			frm.refresh_field("items");
			frm.dirty();
			dialog.hide();
			await frm.call("preview_taxes");
			frm.refresh_fields();
		},
	});
	dialog.show();
}
