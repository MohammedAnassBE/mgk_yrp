frappe.ui.form.on("MGK Delivery Challan", {
	async onload(frm) {
		if (!frm.is_new() || frm.doc.is_return || frm.doc.from_location) return;
		const { message } = await frappe.call({ method: "mgk_yrp.party_defaults.get_own_location" });
		if (frm.is_new() && !frm.doc.is_return && !frm.doc.from_location && message.location) {
			await frm.set_value("from_location", message.location);
			if (!frm.doc.from_warehouse) await frm.set_value("from_warehouse", message.warehouse);
		}
	},
	setup(frm) {
		for (const fieldname of ["from_location", "to_location"]) {
			frm.set_query(fieldname, () => ({ filters: { disabled: 0 } }));
		}
		for (const fieldname of ["from_warehouse", "to_warehouse"]) {
			frm.set_query(fieldname, () => ({ filters: {
				supplier: frm.doc[fieldname.replace("_warehouse", "_location")] || "", disabled: 0, is_group: 0,
			} }));
		}
	},
	refresh(frm) {
		frm.ignore_doctypes_on_cancel_all = [
			"MGK Delivery Challan", "MGK Goods Received Note", "MGK Delivery Challan Close",
			"YRP Stock Ledger Entry", "YRP Repost Item Valuation", "YRP Stock Valuation Adjustment",
			"YRP Stock Valuation Production Link", "YRP Stock Entry",
		];
		frappe.mgk_yrp?.refresh_transfer(frm);
		const can_return = frm.doc.is_internal_transfer
			? (frm.doc.items || []).some(row => frappe.mgk_yrp.pending_transfer_qty(row) > 0.000001)
			: frm.doc.close_status === "Open";
		if (frm.doc.docstatus === 1 && !frm.doc.is_return) {
			if (can_return && frappe.model.can_create("MGK Delivery Challan")) {
				frm.add_custom_button(__("Return"), () => frappe.model.open_mapped_doc({
					method: "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan.make_return_delivery_challan",
					frm,
				}));
			}
			if (!frm.doc.is_internal_transfer && frm.doc.close_status === "Open" && frappe.model.can_create("MGK Delivery Challan Close")) {
				frm.add_custom_button(__("Close"), () => frappe.model.open_mapped_doc({
					method: "mgk_yrp.mgk_yrp.doctype.mgk_delivery_challan.mgk_delivery_challan.make_delivery_challan_close",
					frm,
				}));
			}
		}
		frappe.mgk_yrp.refresh_job_work_challan(frm);
		if (frm.doc.delivery_challan_close) {
			frm.add_custom_button(__("View Close"), () =>
				frappe.set_route("Form", "MGK Delivery Challan Close", frm.doc.delivery_challan_close));
		}
		return frappe.mgk_yrp?.mount_item_editor(frm);
	},
	validate(frm) {
		frappe.mgk_yrp?.sync_item_editor(frm);
	},
	from_location(frm) {
		return mgk_delivery_warehouse(frm, "from");
	},
	to_location(frm) {
		return mgk_delivery_warehouse(frm, "to");
	},
});

async function mgk_delivery_warehouse(frm, side) {
	if (frm.doc.is_return) return;
	const supplier = frm.doc[`${side}_location`];
	await frm.set_value(`${side}_warehouse`, null);
	if (!supplier) return;
	const { message } = await frappe.call({
		method: "mgk_yrp.party_defaults.get_party_defaults", args: { supplier },
	});
	if (frm.doc[`${side}_location`] === supplier && !frm.doc[`${side}_warehouse`] && message.warehouse) {
		await frm.set_value(`${side}_warehouse`, message.warehouse);
	}
}
