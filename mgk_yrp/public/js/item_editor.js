frappe.provide('frappe.mgk_yrp');

frappe.mgk_yrp.item_editor_mode = function (doc) {
    if (doc.doctype === 'MGK Process Planning') return 'plan';
    if (doc.doctype === 'MGK Purchase Order') return 'po';
    if (doc.doctype === 'MGK Delivery Challan') return doc.is_return ? 'dc_return' : 'dc';
    return doc.against_purchase_order ? 'grn_po' : 'grn_job';
};

frappe.mgk_yrp.mount_item_editor = function (frm) {
    if (!frm.fields_dict.item_html || !frappe.mgk_yrp.ItemEditor) return;
    const doc = frm.doc;
    const data = doc.__onload?.item_details || doc.item_details;
    frm.set_df_property('items', 'hidden', 1);
    frm.set_df_property('items', 'reqd', 0);
    if (!data && doc.docstatus === 0 && doc.items?.some(row => row.item)) {
        return hydrate_item_editor(frm);
    }
    frm._mgk_editor_hydration = null;
    const mode = frappe.mgk_yrp.item_editor_mode(frm.doc);
    const signature = JSON.stringify([doc.name, doc.docstatus, doc.modified, mode, data]);
    if (frm.itemEditor && frm._mgk_editor_doc === doc && frm._mgk_editor_signature === signature) {
        frm.itemEditor.update_status();
        return;
    }
    frm.itemEditor?.app.unmount();
    frm.itemEditor = new frappe.mgk_yrp.ItemEditor(frm.fields_dict.item_html.wrapper, { frm, mode });
    frm.itemEditor.load_data(typeof data === 'string' ? JSON.parse(data) : data || []);
    frm.itemEditor.update_status();
    frm._mgk_editor_signature = signature;
    frm._mgk_editor_doc = doc;
};

function hydrate_item_editor(frm) {
    const doc = frm.doc;
    if (frm._mgk_editor_hydration?.doc === doc) return frm._mgk_editor_hydration.promise;
    frm.itemEditor?.app.unmount();
    frm.itemEditor = null;
    const request = { doc };
    frm._mgk_editor_hydration = request;
    request.promise = Promise.resolve(frappe.call({
        method: 'mgk_yrp.stock.item_editor.get_draft_item_details',
        args: { doc: JSON.stringify(doc) },
    })).then(({ message }) => {
        if (frm.doc !== doc || frm._mgk_editor_hydration !== request) return;
        doc.__onload ||= {};
        doc.__onload.item_details = message;
        return frappe.mgk_yrp.mount_item_editor(frm);
    }).finally(() => {
        if (frm._mgk_editor_hydration === request) frm._mgk_editor_hydration = null;
    });
    return request.promise;
}

frappe.mgk_yrp.sync_item_editor = function (frm) {
    if (frm._mgk_editor_hydration?.doc === frm.doc) frappe.throw(__('Items are still loading. Please try again.'));
    if (!frm.itemEditor || frm.doc.docstatus !== 0) return;
    const items = frm.itemEditor.get_items();
    if (!items.some(group => group.items.length)) frappe.throw(__('Enter Qty to continue'));
    frm.doc.item_details = JSON.stringify(items);
    // The server rebuilds these rows from the editor payload before validation.
    frm.clear_table('items');
};

frappe.mgk_yrp.load_item_editor = function (frm, data = []) {
    frm.doc.item_details = typeof data === 'string' ? data : JSON.stringify(data);
    if (frm.doc.__onload) delete frm.doc.__onload.item_details;
    frappe.mgk_yrp.mount_item_editor(frm);
    frm.itemEditor?.load_data(typeof data === 'string' ? JSON.parse(data) : data);
};
