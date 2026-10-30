const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const Vue = require('../../../frappe/node_modules/vue');

const editorDirectory = resolve(__dirname, '../public/js');

function componentScript(filename) {
    return readFileSync(filename, 'utf8').split('<script setup>')[1].split('</script>')[0]
        .replace(/^import .*;$/gm, '');
}

function component(environment, filename, props) {
    let exposed;
    const mounted = [];
    const context = vm.createContext({
        ...environment.globals, ...Vue,
        defineProps: () => props, defineEmits: () => () => {},
        defineExpose: value => { exposed = value; },
        onMounted: callback => mounted.push(callback), onBeforeUnmount() {}, watch() {},
        useRowSelection: () => ({ selected: Vue.ref([]) }),
        protectAttributeAutocomplete: control => control,
        MutationObserver: class { observe() {} disconnect() {} },
    });
    vm.runInContext(componentScript(filename), context);
    return { context, mounted, exposed };
}

function dialogEnvironment(plan = []) {
    const requests = [], controls = [], mounts = [], pending = [];
    let dialog, reloads = 0;
    const frappe = { mgk_yrp: {}, provide() {},
        call: options => {
            requests.push(options);
            let message;
            if (options.method.endsWith('get_process_plan')) message = plan;
            else if (options.method.endsWith('get_editor_context')) {
                message = { defaults: { received_type: 'Accepted' }, po_entries: [] };
            } else if (options.method.endsWith('get_stock_dimensions_for_ui')) {
                message = [{ fieldname: 'received_type', options: 'YRP Received Type', mandatory: 1 }];
            } else if (options.method.endsWith('get_attribute_details')) {
                message = { item: 'Yarn', attributes: ['Colour'], primary_attribute: '',
                    primary_attribute_values: [], default_uom: 'Kg' };
            }
            options.callback?.({ message });
            return Promise.resolve({ message });
        },
        ui: { form: { make_control(options) {
            assert.equal(options.parent.root.isConnected, true);
            const control = { ...options, value: '',
                get_value() { return this.value; }, set_value(value) { this.value = value; } };
            controls.push(control);
            return control;
        } } },
    };
    const environment = { frappe, requests, controls, mounts, pending,
        globals: { frappe, __: value => value, flt: value => Number(value) || 0,
            $: root => ({ find: selector => ({ root, selector, html() {} }) }) } };
    frappe.ui.Dialog = class {
        constructor(options) {
            Object.assign(this, options);
            this.fields_dict = { item_html: { wrapper: { isConnected: false } } };
            dialog = this;
        }
        show() { this.visible = true; }
        finish_show() {
            this.fields_dict.item_html.wrapper.isConnected = true;
            this.on_page_show?.();
        }
        hide() { this.visible = false; this.onhide?.(); }
        get_primary_btn() { return { prop() {} }; }
    };
    frappe.mgk_yrp.ItemEditor = class {
        constructor(wrapper, props) {
            mounts.push(props);
            const editor = component(environment, resolve(editorDirectory, 'ItemEditor.vue'), props);
            this.context = editor.context;
            this.editor = editor.exposed;
            const pickerProps = vm.runInContext('({ get items() { return items.value; }, edit: editable.value, args, showDimensions: true })',
                editor.context);
            this.picker = component(environment, resolve(__dirname,
                '../../../yrp/yrp/public/js/Stock/components/ItemDimensionFetch.vue'), pickerProps);
            this.picker.context.Function = vm.runInContext('Function', editor.context);
            const root = Object.create(wrapper);
            root.querySelector = () => {
                const fieldobj = controls.find(control => control.df.fieldname === 'received_type');
                return fieldobj ? { fieldobj } : null;
            };
            for (const instance of [this.picker, editor]) {
                instance.context.element = root;
                vm.runInContext('root.value = element', instance.context);
                pending.push(...instance.mounted.map(callback => callback()));
            }
            this.app = { unmount: () => { this.unmounted = true; } };
            environment.editor = this;
        }
        load_data(data) { this.editor.load_data(data); }
        get_items() { return this.editor.get_items(); }
    };
    vm.runInNewContext(readFileSync(resolve(editorDirectory, 'job_work.js'), 'utf8'), environment.globals);
    environment.open = async () => {
        await frappe.mgk_yrp.open_plan_dialog({ doc: { name: 'DC-1' }, reload_doc: async () => reloads++ });
        return dialog;
    };
    environment.reloads = () => reloads;
    return environment;
}

async function finishShowing(environment, dialog) {
    dialog.finish_show();
    await Promise.all(environment.pending);
    await Vue.nextTick();
    vm.runInContext('prefillDimensions()', environment.editor.context);
}

test('empty plan mounts its fake-form picker after the animated dialog is attached', async () => {
    const environment = dialogEnvironment();
    const dialog = await environment.open();
    await Promise.all(environment.pending);
    assert.equal(environment.controls.length, 0, 'Bootstrap has not attached the modal yet');
    await finishShowing(environment, dialog);
    assert.equal(environment.mounts.length, 1);
    assert.equal(environment.mounts[0].mode, 'plan');
    assert.equal(environment.mounts[0].frm.doc.doctype, 'MGK Process Planning');
    assert.equal(environment.mounts[0].frm.doc.docstatus, 0);
    assert.deepEqual(environment.controls.map(control => control.df.fieldname), ['received_type', 'item']);
    assert.equal(environment.controls[0].get_value(), 'Accepted');
    assert.equal(vm.runInContext('can_create.value && props.edit && dimensions_loaded.value',
        environment.editor.picker.context), true);
    assert.deepEqual(JSON.parse(JSON.stringify(environment.editor.get_items())), []);
    dialog.on_page_show();
    assert.equal(environment.mounts.length, 1, 'shown callback does not mount twice');
    assert.equal(environment.requests.some(request => /converted_outputs/.test(request.method)), false);
    await dialog.primary_action();
    assert.equal(environment.requests.at(-1).args.item_details, '[]');
    assert.equal(environment.reloads(), 1);
    assert.equal(environment.editor.unmounted, true);
});

test('existing plan keeps editable attributes, quantities, split and removal in the popup', async () => {
    const plan = [{ attributes: ['Colour'], primary_attribute: 'Size', primary_attribute_values: ['S', 'M'],
        items: [{ name: 'Tee', attributes: { Colour: 'Red' }, dimensions: { received_type: 'Accepted' },
            values: { S: { qty: 5, uom: 'Kg', amount: 0 }, M: null } }] }];
    const environment = dialogEnvironment(plan);
    const dialog = await environment.open();
    await finishShowing(environment, dialog);
    const editor = environment.editor;
    assert.deepEqual(JSON.parse(JSON.stringify(editor.get_items())), plan);
    vm.runInContext('addSplit(0, 0)', editor.context);
    const grid = component(environment, resolve(editorDirectory, 'AttributeColumns.vue'), {
        items: editor.get_items(), edit: true, mode: 'plan',
    });
    vm.runInContext("setAttribute(props.items[0].items[1], 'Colour', 'Blue');" +
        "setDimension(props.items[0].items[1], 'received_type', 'Rejected');" +
        "setQuantity(props.items[0].items[1], 'S', '3')", grid.context);
    const rows = editor.get_items()[0].items;
    assert.equal(rows[0].attributes.Colour, 'Red');
    assert.equal(rows[0].values.S.qty, 5);
    assert.equal(rows[1].attributes.Colour, 'Blue');
    assert.equal(rows[1].dimensions.received_type, 'Rejected');
    assert.equal(rows[1].values.S.qty, 3);
    assert.equal(rows[1].values.M, null);
    vm.runInContext('removeRow(0, 0)', grid.context);
    assert.equal(rows.length, 1);
    await dialog.primary_action();
    const saved = JSON.parse(environment.requests.at(-1).args.item_details);
    assert.equal(saved[0].items[0].attributes.Colour, 'Blue');
    assert.equal(saved[0].items[0].values.S.qty, 3);
    vm.runInContext('removeAll()', editor.context);
    assert.equal(editor.get_items().length, 0);
});

test('empty plan accepts a fetched item with received type, attribute, quantity and item UOM', async () => {
    const environment = dialogEnvironment();
    const dialog = await environment.open();
    await finishShowing(environment, dialog);
    environment.controls.find(control => control.df.fieldname === 'item').set_value('Yarn');
    const context = environment.editor.picker.context;
    vm.runInContext('get_item_details()', context);
    environment.controls.find(control => control.df.fieldname === 'Colour').set_value('Blue');
    vm.runInContext('item.value.values.default.qty = 7', context);
    await vm.runInContext('add_item()', context);
    const [entry] = environment.editor.get_items()[0].items;
    assert.equal(entry.name, 'Yarn');
    assert.equal(entry.attributes.Colour, 'Blue');
    assert.equal(entry.dimensions.received_type, 'Accepted');
    assert.equal(entry.values.default.qty, 7);
    assert.equal(entry.default_uom, 'Kg');
    await dialog.primary_action();
    const saved = JSON.parse(environment.requests.at(-1).args.item_details);
    assert.equal(saved[0].items[0].values.default.qty, 7);
});
