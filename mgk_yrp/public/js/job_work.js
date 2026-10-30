frappe.provide('frappe.mgk_yrp');

frappe.mgk_yrp.refresh_job_work_challan = function (frm) {
    const doc = frm.doc;
    if (doc.docstatus !== 1 || doc.is_return || doc.is_internal_transfer || doc.close_status !== 'Open') return;
    if (frappe.model.can_create('MGK Goods Received Note')) {
        frm.add_custom_button(__('Create GRN'), () => frappe.model.open_mapped_doc({
            method: 'mgk_yrp.job_work.grn_from_dc.make_job_work_grn', frm,
        }));
    }
    if (frappe.model.can_write('MGK Process Planning')) {
        frm.add_custom_button(__('Update Plan'), () => frappe.mgk_yrp.open_plan_dialog(frm));
    }
};

frappe.mgk_yrp.refresh_job_work_receipt = function (frm) {
    if (frm.doc.docstatus !== 1 || frm.doc.is_internal_transfer || !frappe.model.can_create('MGK Delivery Challan')) return;
    frm.add_custom_button(__('Create DC'), () => frappe.mgk_yrp.open_dispatch_dialog(
        [frm.doc.name], [frm.doc.warehouse], () => frm.reload_doc()));
};

frappe.mgk_yrp.create_grn_from_selection = async function (listview) {
    const source_names = listview.get_checked_items().map(row => row.name);
    if (!source_names.length) frappe.throw(__('Select at least one Delivery Challan.'));
    const { message } = await frappe.call({
        method: 'mgk_yrp.job_work.grn_from_dc.make_job_work_grn',
        args: { source_names }, freeze: true,
    });
    frappe.model.sync(message);
    return frappe.set_route('Form', 'MGK Goods Received Note', message.name);
};

frappe.mgk_yrp.dispatch_selection = function (listview) {
    const rows = listview.get_checked_items();
    if (!rows.length) frappe.throw(__('Select at least one Goods Received Note.'));
    return frappe.mgk_yrp.open_dispatch_dialog(rows.map(row => row.name),
        rows.map(row => row.warehouse), () => listview.refresh());
};

frappe.mgk_yrp.open_plan_dialog = async function (frm) {
    const delivery_challan = frm.doc.name;
    const { message } = await frappe.call({ method: 'mgk_yrp.job_work.process_plan.get_process_plan',
        args: { delivery_challan }, freeze: true });
    let editor;
    const dialog = new frappe.ui.Dialog({ title: __('Update Plan'), size: 'extra-large',
        fields: [{ fieldname: 'item_html', fieldtype: 'HTML' }],
        primary_action_label: __('Save'),
        primary_action: () => save_plan_dialog(dialog, editor, delivery_challan, frm),
        onhide: () => editor?.app.unmount(),
        on_page_show() {
            if (editor) return;
            editor = new frappe.mgk_yrp.ItemEditor(dialog.fields_dict.item_html.wrapper, { mode: 'plan',
                frm: { doc: { doctype: 'MGK Process Planning', docstatus: 0 }, set_value() {}, dirty() {} } });
            editor.load_data(message || []);
            dialog.get_primary_btn().prop('disabled', false);
        },
    });
    dialog.get_primary_btn().prop('disabled', true);
    dialog.show();
    return dialog;
};

async function save_plan_dialog(dialog, editor, delivery_challan, frm) {
    if (dialog.saving) return;
    dialog.saving = true;
    dialog.get_primary_btn().prop('disabled', true);
    try {
        await frappe.call({ method: 'mgk_yrp.job_work.process_plan.save_process_plan', freeze: true,
            args: { delivery_challan, item_details: JSON.stringify(editor.get_items()) } });
        dialog.hide();
        await frm.reload_doc();
    } finally {
        dialog.saving = false;
        dialog.get_primary_btn().prop('disabled', false);
    }
}

frappe.mgk_yrp.open_dispatch_dialog = function (names, warehouses, refresh) {
    const source_names = [...names];
    const must_move = new Set(warehouses).size > 1;
    const dialog = new frappe.ui.Dialog({ title: __('Create DC'),
        fields: [
            { fieldname: 'process_name', fieldtype: 'Link', options: 'YRP Process', label: __('Process'), reqd: 1 },
            { fieldname: 'supplier', fieldtype: 'Link', options: 'Supplier', label: __('Supplier'), reqd: 1,
                get_query: () => ({ filters: { is_company_location: 0, disabled: 0 } }) },
            { fieldname: 'move_to_head_office', fieldtype: 'Check', label: __('Move stock to Head Office'),
                default: must_move ? 1 : 0, read_only: must_move ? 1 : 0 },
        ],
        primary_action_label: __('Create DC'),
        primary_action: values => submit_dispatch(dialog, { source_names, process_name: values.process_name,
            supplier: values.supplier, move_to_head_office: must_move ? 1 : values.move_to_head_office || 0 }, refresh),
    });
    dialog.show();
    return dialog;
};

async function submit_dispatch(dialog, args, refresh) {
    if (dialog.saving) return;
    dialog.saving = true;
    dialog.get_primary_btn().prop('disabled', true);
    try {
        const { message } = await frappe.call({
            method: 'mgk_yrp.job_work.dc_from_grn.make_delivery_challan_from_grns', args, freeze: true,
        });
        dialog.hide();
        show_dispatch_result(message);
        await refresh?.();
    } finally {
        dialog.saving = false;
        dialog.get_primary_btn().prop('disabled', false);
    }
}

function show_dispatch_result(result) {
    const links = [frappe.utils.get_form_link('MGK Delivery Challan', result.delivery_challan, true),
        ...result.stock_entries.map(name => frappe.utils.get_form_link('YRP Stock Entry', name, true))];
    frappe.msgprint({ title: __('Dispatch submitted'), indicator: 'green', message: links.join('<br>') });
}
