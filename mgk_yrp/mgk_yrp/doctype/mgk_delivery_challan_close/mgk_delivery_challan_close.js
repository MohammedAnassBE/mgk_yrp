frappe.ui.form.on("MGK Delivery Challan Close", {
	setup(frm) {
		const can_amend = frm.toolbar.can_amend.bind(frm.toolbar);
		frm.toolbar.can_amend = () => !["Reversing", "Reopening"].includes(frm.doc.reopen_status) && can_amend();
		const set_action = frm.page.set_action.bind(frm.page);
		frm.page.set_action = (button, options) => {
			// A toolbar lookup started before setup can finish after refresh.
			if (options.label === __("Amend") && !frm.toolbar.can_amend()) {
				return frm.page.clear_action_of(button);
			}
			return set_action(button, options);
		};
		frm.set_query("delivery_challan", () => ({
			filters: { docstatus: 1, is_return: 0, close_status: "Open" },
		}));
	},
	refresh(frm) {
		frm.ignore_doctypes_on_cancel_all = [
			"MGK Delivery Challan", "YRP Stock Ledger Entry", "YRP Repost Item Valuation",
			"YRP Stock Valuation Adjustment", "YRP Stock Valuation Production Link",
		];
		refresh_close_actions(frm);
		refresh_close_intro(frm);
		refresh_close_values(frm);
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

function refresh_close_actions(frm) {
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
	}
}

function refresh_close_intro(frm) {
	if (["Reversing", "Reopening"].includes(frm.doc.reopen_status)) {
		frm.set_intro(__("Reversing valuation; consumption will be cancelled when the reversal completes."), "orange");
	} else if (frm.doc.reopen_status === "Reopened") {
		frm.set_intro(__("Delivery Challan reopened."), "green");
	} else if ((frm.doc.outputs || []).length) {
		const values = [format_currency(frm.doc.value_per_unit), frm.doc.output_stock_uom, frm.doc.outputs.length];
		frm.set_intro(frm.doc.docstatus === 0
			? __("Adds {0} per {1} to {2} GRN rows", values)
			: __("At close: added {0} per {1} to {2} GRN rows", values));
	} else {
		frm.set_intro(frm.doc.docstatus === 0
			? __("No linked GRN: {0} will be written off", [format_currency(frm.doc.loss_value)])
			: __("At close: {0} was written off (no linked GRN)", [format_currency(frm.doc.loss_value)]));
	}
}

function refresh_close_values(frm) {
	const draft = frm.doc.docstatus === 0;
	frm.set_df_property("value_per_unit", "label", draft ? __("Value Per Unit") : __("Value Per Unit at Close"));
	frm.set_df_property("total_value_gap", "hidden", draft);
	const items = frm.fields_dict.items.grid;
	for (const field of ["consumed_value", "value_gap"]) {
		items.update_docfield_property(field, "hidden", draft);
	}
	items.refresh();
	const outputs = frm.fields_dict.outputs.grid;
	for (const field of ["allocated_value", "allocated_rate"]) {
		outputs.update_docfield_property(field, "hidden", draft);
	}
	outputs.update_docfield_property("allocated_rate", "label",
		draft ? __("Allocated Rate") : __("Allocated Rate at Close"));
	outputs.refresh();
}
