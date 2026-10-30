frappe.ui.form.on('MGK Process Planning', {
    refresh(frm) {
        frm.set_intro(__('Edit from the Delivery Challan (Update Plan).'));
        frm.disable_save();
        frm._mgk_plan_display?.itemEditor?.app.unmount();
        const display = Object.create(frm);
        display.doc = { ...frm.doc, docstatus: 1 };
        display.itemEditor = null;
        display.set_value = () => {};
        display.dirty = () => {};
        frm._mgk_plan_display = display;
        frappe.mgk_yrp.mount_item_editor(display);
    },
});
