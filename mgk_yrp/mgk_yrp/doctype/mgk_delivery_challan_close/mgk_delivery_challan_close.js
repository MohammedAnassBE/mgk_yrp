frappe.ui.form.on("MGK Delivery Challan Close", {
	setup(frm) {
		frm.set_query("delivery_challan", () => ({
			filters: { docstatus: 1, is_return: 0, close_status: "Open" },
		}));
	},
	refresh(frm) {
		frm.ignore_doctypes_on_cancel_all = ["MGK Delivery Challan", "YRP Stock Valuation Adjustment"];
		if (frm.doc.docstatus === 1 && frappe.model.can_cancel(frm.doctype)) {
			frm.add_custom_button(__("Reopen"), () => frm.savecancel());
		}
		if (frm.doc.reopen_status === "Reversing") {
			frm.set_intro(__("Reversing valuation; consumption will be cancelled when the reversal completes."), "orange");
			if (frappe.model.can_cancel(frm.doctype)) {
				frm.add_custom_button(__("Finish Reopen"), async () => {
					const result = await frappe.call({
						method: "mgk_yrp.job_work.reopen.finish_reopen",
						args: { close_name: frm.doc.name }, freeze: true,
					});
					if (!result.message) frappe.msgprint(__("The reversal is still processing."));
					await frm.reload_doc();
				});
			}
		} else if (frm.doc.reopen_status === "Reopened") {
			frm.set_intro(__("Delivery Challan reopened."), "green");
		} else if ((frm.doc.outputs || []).length) {
			frm.set_intro(__("Adds ₹{0} per {1} to {2} GRN rows", [
				flt(frm.doc.value_per_unit, 6), frm.doc.output_stock_uom, frm.doc.outputs.length,
			]));
		} else {
			frm.set_intro(__("No linked GRN: ₹{0} will be written off", [flt(frm.doc.loss_value, 6)]));
		}
		mgk_close_valuation_status(frm);
	},
	delivery_challan(frm) {
		if (frm.doc.docstatus === 0 && frm.doc.delivery_challan) {
			return frm.call("preview").then(() => frm.refresh_fields());
		}
	},
});

async function mgk_close_valuation_status(frm) {
	if (!frm.doc.stock_valuation_adjustment) return;
	const response = await frappe.db.get_value("YRP Stock Valuation Adjustment",
		frm.doc.stock_valuation_adjustment, "status");
	if (response.message) {
		const status = response.message.status;
		frm.dashboard.add_indicator(__("Valuation: {0}", [status]),
			["Completed", "Reversed"].includes(status) ? "green" : "orange");
	}
}
