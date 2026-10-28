frappe.ui.form.on("MGK Delivery Challan Close", {
	setup(frm) {
		const can_amend = frm.toolbar.can_amend.bind(frm.toolbar);
		frm.toolbar.can_amend = () => !["Reversing", "Reopening"].includes(frm.doc.reopen_status) && can_amend();
		frm.set_query("delivery_challan", () => ({
			filters: { docstatus: 1, is_return: 0, close_status: "Open" },
		}));
	},
	refresh(frm) {
		frm.ignore_doctypes_on_cancel_all = [
			"MGK Delivery Challan", "YRP Stock Ledger Entry", "YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment", "YRP Stock Valuation Production Link",
		];
		if (frm.doc.docstatus === 1 && frappe.model.can_cancel(frm.doctype)) {
			frm.page.clear_secondary_action();
			frm.add_custom_button(__("Reopen"), () => {
				frm.validate_form_action("Cancel");
				frappe.confirm(
					__("Reopen Delivery Challan {0}? Its valuation will be reversed before stock is released.",
						[frm.doc.delivery_challan]),
					() => frm._cancel(null, null, null, true),
				);
			});
		}
		if (frm.doc.docstatus === 2 && frm.doc.reopen_status === "Reversing") {
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
			frm.set_intro(__("Adds {0} per {1} to {2} GRN rows", [
				format_currency(frm.doc.value_per_unit), frm.doc.output_stock_uom, frm.doc.outputs.length,
			]));
		} else {
			frm.set_intro(__("No linked GRN: {0} will be written off", [format_currency(frm.doc.loss_value)]));
		}
		const status = frm.doc.__onload?.valuation_status;
		if (status) {
			frm.dashboard.add_indicator(__("Valuation: {0}", [status]),
				["Completed", "Reversed"].includes(status) ? "green" : "orange");
		}
	},
	delivery_challan(frm) {
		if (frm.doc.docstatus === 0 && frm.doc.delivery_challan) {
			return frm.call("preview").then(() => frm.refresh_fields());
		}
	},
});
