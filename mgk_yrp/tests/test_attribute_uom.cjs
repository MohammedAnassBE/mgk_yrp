const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function grid(group) {
    const source = readFileSync(resolve(__dirname, '../public/js/AttributeColumns.vue'), 'utf8')
        .split('<script setup>')[1].split('</script>')[0].replace(/^import .*;$/gm, '');
    const context = vm.createContext({
        defineProps: () => ({ items: [group] }), defineEmits: () => () => {},
        ref: value => ({ value }), watch() {}, onMounted() {}, __: value => value,
    });
    vm.runInContext(source, context);
    return context;
}

test('F6.9 dependent dropdown refreshes every occupied cell UOM without creating variants', () => {
    const entry = { name: 'Yarn', attributes: { Stage: 'Raw' }, default_uom: 'Kg',
        values: { S: { qty: 4, rate: 10, uom: 'Kg' }, M: { qty: 2, uom: 'Kg' }, L: null } };
    const context = grid({ items: [entry], dependent_attribute: 'Stage',
        dependent_attribute_details: { attr_list: { Raw: { uom: 'Kg' }, Wound: { uom: 'Cone' } } } });
    vm.runInContext("setAttribute(props.items[0].items[0], 'Stage', 'Wound')", context);
    assert.equal(entry.default_uom, 'Cone');
    assert.equal(entry.values.S.uom, 'Cone');
    assert.equal(entry.values.M.uom, 'Cone');
    assert.equal(entry.values.S.qty, 4);
    assert.equal(entry.values.S.rate, 10);
    assert.equal(entry.values.L, null);
    assert.equal(entry.uom_hint, '');
    vm.runInContext("setAttribute(props.items[0].items[0], 'Stage', 'Raw')", context);
    assert.equal(entry.values.S.uom, 'Kg');
});

test('F6.9 missing UOM metadata clears stale units and displays a save hint', () => {
    const entry = { name: 'Yarn', attributes: {}, default_uom: 'Kg', values: { default: { qty: 5, uom: 'Kg' } } };
    const context = grid({ items: [entry] });
    vm.runInContext("setAttribute(props.items[0].items[0], 'Stage', 'Wound')", context);
    assert.equal(entry.default_uom, '');
    assert.equal(entry.values.default.uom, '');
    assert.match(entry.uom_hint, /resolved from the Item when saved/);
});

test('F6.9 a shared attribute group never borrows a different template UOM mapping', () => {
    const entry = { name: 'Second Yarn', attributes: {}, default_uom: 'Kg', values: { default: { qty: 5, uom: 'Kg' } } };
    const context = grid({ items: [{ name: 'First Yarn' }, entry], dependent_attribute: 'Stage',
        dependent_attribute_details: { attr_list: { Wound: { uom: 'Cone' } } } });
    vm.runInContext("setAttribute(props.items[0].items[1], 'Stage', 'Wound')", context);
    assert.equal(entry.values.default.uom, '');
    assert.match(entry.uom_hint, /resolved from the Item when saved/);
});
