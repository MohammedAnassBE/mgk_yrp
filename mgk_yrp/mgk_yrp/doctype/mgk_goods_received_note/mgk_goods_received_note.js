frappe.ui.form.on("MGK Goods Received Note", {
	async onload(frm) {
		if (frm.doc.docstatus !== 0 || frm.doc.against_purchase_order) return;
		const { message } = await frappe.call({ method: "mgk_yrp.party_defaults.get_own_location" });
		frm._mgk_own_location = message.location;
		if (frm.is_new() && !frm.doc.against_purchase_order && !frm.doc.delivery_location && !frm.doc.warehouse) {
			await frm.set_value("warehouse", message.warehouse);
		}
	},
	setup(frm) {
		frm.set_query("warehouse", () => ({ filters: {
			supplier: frm.doc.delivery_location || frm._mgk_own_location || "", disabled: 0, is_group: 0,
		} }));
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
			"MGK Purchase Invoice", "MGK Delivery Challan", "MGK Delivery Challan Close", "YRP Stock Ledger Entry",
			"YRP Repost Item Valuation", "YRP Stock Valuation Adjustment", "YRP Stock Valuation Production Link", "YRP Stock Entry",
		];
		set_purchase_order_fields(frm);
		frappe.mgk_yrp?.refresh_transfer(frm);
		frappe.mgk_yrp.refresh_job_work_receipt(frm);
		return frappe.mgk_yrp?.mount_item_editor(frm);
	},
	validate(frm) {
		frappe.mgk_yrp?.sync_item_editor(frm);
	},
	async delivery_location(frm) {
		if (frm.doc.against_purchase_order) return;
		await frm.set_value("warehouse", null);
		const supplier = frm.doc.delivery_location;
		if (!supplier) {
			const { message } = await frappe.call({ method: "mgk_yrp.party_defaults.get_own_location" });
			frm._mgk_own_location = message.location;
			if (!frm.doc.delivery_location && !frm.doc.against_purchase_order && !frm.doc.warehouse) {
				await frm.set_value("warehouse", message.warehouse);
			}
			return;
		}
		const { message } = await frappe.call({
			method: "mgk_yrp.party_defaults.get_party_defaults", args: { supplier },
		});
		if (frm.doc.delivery_location === supplier && !frm.doc.warehouse && !frm.doc.against_purchase_order) {
			await frm.set_value("warehouse", message.warehouse);
		}
	},
	supplier(frm) {
		frm.clear_table("delivery_challans");
		frm.refresh_field("delivery_challans");
	},
	against_purchase_order(frm) {
		frm._mgk_po_request = (frm._mgk_po_request || 0) + 1;
		set_purchase_order_fields(frm);
		frm.clear_table("items");
		frappe.mgk_yrp?.load_item_editor(frm);
		frm.clear_table("delivery_challans");
		frm.refresh_fields();
		return frm.set_value({ purchase_order: "", process_name: "", total_qty: 0, total_amount: 0 });
	},
	async purchase_order(frm) {
		const doc = frm.doc;
		const request = frm._mgk_po_request = (frm._mgk_po_request || 0) + 1;
		const source_name = doc.purchase_order;
		frm.clear_table("items");
		frappe.mgk_yrp?.load_item_editor(frm);
		await frm.set_value({ process_name: "", total_qty: 0, total_amount: 0 });
		if (!source_name || !is_current_purchase_order_request(frm, doc, request, source_name)) return;
		const { message } = await frappe.call({
			method: "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.make_goods_received_note",
			args: { source_name },
		});
		if (!is_current_purchase_order_request(frm, doc, request, source_name)) return;
		await frm.set_value({
			supplier: message.supplier, delivery_location: message.delivery_location,
			warehouse: message.warehouse, total_qty: message.total_qty, total_amount: message.total_amount,
		});
		if (is_current_purchase_order_request(frm, doc, request, source_name)) {
			frappe.mgk_yrp?.load_item_editor(frm, message.__onload.item_details);
		}
	},
});

function is_current_purchase_order_request(frm, doc, request, source_name) {
	return frm.doc === doc && frm._mgk_po_request === request
		&& doc.purchase_order === source_name && doc.against_purchase_order;
}

function set_purchase_order_fields(frm) {
	const against_order = Boolean(frm.doc.against_purchase_order);
	for (const field of ["supplier", "delivery_location"]) frm.set_df_property(field, "read_only", against_order);
}
