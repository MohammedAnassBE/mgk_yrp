frappe.provide("frappe.mgk_yrp");

frappe.mgk_yrp.transfer_indicator = function (doc) {
	const colors = { "In Transit": "orange", "Partly Transferred": "yellow", Transferred: "green", Returned: "grey" };
	if (doc.is_internal_transfer && colors[doc.transfer_status]) {
		return [__(doc.transfer_status), colors[doc.transfer_status], `transfer_status,=,${doc.transfer_status}`];
	}
};

frappe.mgk_yrp.pending_transfer_qty = function (row) {
	return flt(row.qty) - flt(row.transferred_qty) - flt(row.returned_qty) / (flt(row.conversion_factor) || 1);
};

frappe.mgk_yrp.refresh_transfer = function (frm) {
	if (frm.doc.docstatus !== 1 || !frm.doc.is_internal_transfer) return;
	const pending = (frm.doc.items || []).filter(row => frappe.mgk_yrp.pending_transfer_qty(row) > 0.000001);
	const indicator = frappe.mgk_yrp.transfer_indicator(frm.doc);
	if (pending.length) {
		const quantities = pending.map(row => frappe.utils.escape_html(
			`${row.item} ${flt(frappe.mgk_yrp.pending_transfer_qty(row), 6)} ${row.uom || ''}`.trim()
		)).join(', ');
		frm.set_intro(__("Pending in transit: {0}", [quantities]), indicator?.[1] || 'orange');
	} else frm.set_intro('');
	if (!pending.length || !frappe.model.can_create("YRP Stock Entry")) return;
	frm.add_custom_button(__("Complete Transfer"), () => frappe.mgk_yrp.show_transfer_dialog(frm, pending));
};

frappe.mgk_yrp.show_transfer_dialog = function (frm, pending) {
	const is_challan = frm.doctype === "MGK Delivery Challan";
	const dialog = new frappe.ui.Dialog({
		title: __("Complete Transfer"),
		fields: [
			{ fieldname: "warehouse", fieldtype: "Link", options: "Warehouse", label: __("Receiving Warehouse"), reqd: 1,
				default: is_challan ? frm.doc.to_warehouse : frm.doc.warehouse,
				get_query: () => ({ filters: { supplier: is_challan ? frm.doc.to_location : frm.doc.delivery_location,
					disabled: 0, is_group: 0, name: ["!=", frm.doc.transit_warehouse] } }) },
			{ fieldname: "items", fieldtype: "Table", label: __("Pending Items"), cannot_add_rows: true, cannot_delete_rows: true,
				data: pending.map(row => ({ source_row: row.name, item: row.item, uom: row.uom,
					pending_qty: frappe.mgk_yrp.pending_transfer_qty(row), qty: frappe.mgk_yrp.pending_transfer_qty(row) })),
				fields: [
					{ fieldname: "source_row", fieldtype: "Data", hidden: 1 },
					{ fieldname: "item", fieldtype: "Link", options: "Item", label: __("Item"), read_only: 1, in_list_view: 1 },
					{ fieldname: "uom", fieldtype: "Link", options: "UOM", label: __("UOM"), read_only: 1, in_list_view: 1 },
					{ fieldname: "pending_qty", fieldtype: "Float", label: __("Pending"), read_only: 1, in_list_view: 1 },
					{ fieldname: "qty", fieldtype: "Float", label: __("Quantity"), in_list_view: 1 },
				] },
		],
		primary_action_label: __("Complete Transfer"),
		async primary_action(values) {
			const items = (values.items || []).filter(row => flt(row.qty) !== 0);
			if (!items.length) frappe.throw(__("Enter a positive quantity to complete the transfer."));
			if (items.some(row => flt(row.qty) < 0 || flt(row.qty) > flt(row.pending_qty))) {
				frappe.throw(__("Quantity must be positive and cannot exceed pending quantity."));
			}
			const { message } = await frappe.call({ method: "mgk_yrp.stock.transit.complete_transfer", freeze: true,
				args: { doctype: frm.doctype, name: frm.doc.name, warehouse: values.warehouse,
					items: items.map(row => ({ name: row.source_row, qty: flt(row.qty) })) } });
			dialog.hide();
			frappe.msgprint(__("Stock Entry {0} submitted.", [frappe.utils.get_form_link("YRP Stock Entry", message, true)]));
			await frm.reload_doc();
		},
	});
	dialog.show();
};
