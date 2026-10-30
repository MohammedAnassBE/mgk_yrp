const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function editorHarness() {
    const source = readFileSync(resolve(__dirname, '../public/js/ItemEditor.vue'), 'utf8')
        .split('<script setup>')[1].split('</script>')[0].replace(/^import .*;$/gm, '');
    let editor;
    const context = vm.createContext({
        defineProps: () => ({ mode: 'grn_job', frm: { doc: { docstatus: 0 }, set_value() {}, dirty() {} } }),
        ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
        onMounted() {}, onBeforeUnmount() {}, defineExpose: value => { editor = value; },
        __: text => text, flt: value => Number(value || 0),
    });
    vm.runInContext(source, context);
    return { editor, context };
}

test('Add Split retains each occupied size source link through editor load and save', () => {
    const { editor, context } = editorHarness();
    editor.load_data([{ items: [{ name: 'Yarn', row_index: '0', attributes: { Colour: 'Raw' },
        values: {
            S: { name: 'GRN-row-S', qty: 10, delivery_challan_item: 'DC-row-S' },
            M: { qty: 0, is_prefilled: 1, delivery_challan_item: 'DC-row-M' },
            L: { qty: 0 }, XL: null,
        } }] }]);
    vm.runInContext('addSplit(0, 0)', context);
    const [original, split] = editor.get_items()[0].items;
    split.attributes.Colour = 'Blue';
    split.values.S.qty = 4;
    assert.equal(original.attributes.Colour, 'Raw');
    assert.equal(original.values.S.qty, 10);
    for (const size of ['S', 'M']) {
        assert.equal(split.values[size].delivery_challan_item, `DC-row-${size}`);
        assert.equal(split.values[size].is_prefilled, 1);
        assert.equal(split.values[size].name, undefined);
    }
    assert.equal(split.values.L, null);
    assert.equal(split.values.XL, null);
    editor.load_data(editor.get_items());
    assert.equal(editor.get_items()[0].items[1].values.S.delivery_challan_item, 'DC-row-S');
});

test('DC source line is hidden, read only, and omitted on document copy', () => {
    const schema = JSON.parse(readFileSync(resolve(__dirname,
        '../mgk_yrp/doctype/mgk_goods_received_note_item/mgk_goods_received_note_item.json')));
    const field = schema.fields.find(field => field.fieldname === 'delivery_challan_item');
    assert.equal(field.fieldtype, 'Data');
    assert.equal(field.hidden, 1);
    assert.equal(field.read_only, 1);
    assert.equal(field.no_copy, 1);
    assert.ok(schema.field_order.includes(field.fieldname));
});
