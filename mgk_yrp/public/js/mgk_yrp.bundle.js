import { createApp } from 'vue';
import ItemEditor from './ItemEditor.vue';
import './item_editor';
import './transit';
import './job_work';

frappe.mgk_yrp.ItemEditor = class {
    constructor(wrapper, options) {
        this.app = createApp(ItemEditor, options);
        SetVueGlobals(this.app);
        this.editor = this.app.mount(wrapper);
    }
    get_items() { return this.editor.get_items(); }
    load_data(data) { this.editor.load_data(data); }
    update_status() { this.editor.update_status(); }
};
