<template>
    <div ref="root">
    <div v-if="attributeGrid && editable" class="d-flex mb-3" style="gap: 0.5rem;">
        <button type="button" class="btn btn-sm btn-default" @click="showSplitDialog">{{ __('Add Split') }}</button>
        <button type="button" class="btn btn-sm btn-default" @click="removeAll">{{ __('Remove All') }}</button>
    </div>
    <AttributeColumns v-if="attributeGrid" :items="items" :edit="editable" :mode="props.mode"
        @changed="changed" @split="addSplit" />
    <div :class="{ 'mgk-picker-only': attributeGrid }">
    <ItemDimensionFetch :items="items" :edit="editable" :show-dimensions="true"
        :lock-dimensions-on-edit="props.mode === 'dc_return'"
        :table-fields="tableFields" :qty-fields="locked || props.mode === 'plan' ? [] : ['rate']"
        :args="args" :validate-qty="props.mode !== 'grn_job'" :validate="validateItem"
        :inline-qty-edit="true" :inline-qty-max-field="locked ? 'allowed_qty' : ''"
        @itemadded="itemAdded" @itemupdated="changed" @itemremoved="changed" />
    </div>
    </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import ItemDimensionFetch from '../../../../yrp/yrp/public/js/Stock/components/ItemDimensionFetch.vue';
import AttributeColumns from './AttributeColumns.vue';

const props = defineProps({ frm: Object, mode: String });
const items = ref([]);
const root = ref(null);
const context = ref({ defaults: {}, po_entries: [] });
const ready = ref(false);
const initializedControls = new WeakSet();
let observer;
const editable = ref(props.frm.doc.docstatus === 0);
const locked = computed(() => ['dc_return', 'grn_po'].includes(props.mode));
const attributeGrid = computed(() => ['grn_job', 'plan'].includes(props.mode));
const tableFields = computed(() => {
    if (props.mode === 'plan') return [];
    const fields = [
        { name: 'rate', label: __('Rate'), uses_primary_attribute: true,
            inline_edit: !locked.value, reqd: props.mode === 'po', min: 0, format: format_currency },
        { name: 'amount', label: __('Amount'), uses_primary_attribute: true, format: format_currency },
    ];
    if (props.mode === 'grn_po') fields.push(
        { name: 'pending_qty', label: __('Pending'), uses_primary_attribute: true },
        { name: 'allowed_qty', label: __('Allowed'), uses_primary_attribute: true },
    );
    return fields;
});
const args = {
    can_create: () => props.mode !== 'dc_return' && ready.value,
    can_edit: () => !locked.value,
    can_remove: () => !locked.value,
    item_query: () => ({ filters: itemFilters() }),
};

function itemFilters() {
    const filters = { is_stock_item: 1, disabled: 0, variant_of: ['is', 'not set'] };
    if (props.mode === 'grn_po') filters.name = ['in', context.value.po_entries.map(entry => entry.name)];
    return filters;
}

function validateItem(entry) {
    if (props.mode === 'grn_po') return preparePurchaseOrderEntry(entry);
    if (props.mode !== 'po') return true;
    const valid = Object.values(entry.values).every(cell => !flt(cell.qty) || flt(cell.rate) > 0);
    if (!valid) frappe.msgprint(__('Rate must be greater than zero.'));
    return valid;
}

function sameAttributes(left, right) {
    return JSON.stringify(Object.entries(left || {}).sort()) === JSON.stringify(Object.entries(right || {}).sort());
}

function preparePurchaseOrderEntry(entry) {
    const sources = context.value.po_entries.filter(source => source.name === entry.name
        && sameAttributes(source.attributes, entry.attributes));
    for (const [key, cell] of Object.entries(entry.values)) {
        if (!cell || !flt(cell.qty)) continue;
        const matches = sources.map(source => source.values[key]).filter(source => source?.purchase_order_item
            && (!cell.purchase_order_item || source.purchase_order_item === cell.purchase_order_item));
        if (matches.length !== 1) {
            frappe.msgprint(__('Expected exactly one Purchase Order row for this item variant.'));
            return false;
        }
        const { purchase_order_item, rate, uom, stock_uom, conversion_factor, pending_qty, allowed_qty } = matches[0];
        Object.assign(cell, { purchase_order_item, rate, uom, stock_uom, conversion_factor, pending_qty, allowed_qty });
    }
    return true;
}

onMounted(async () => {
    const { message } = await frappe.call({
        method: 'mgk_yrp.stock.item_editor.get_editor_context',
        args: { purchase_order: props.mode === 'grn_po' ? props.frm.doc.purchase_order : null },
    });
    if (!root.value?.isConnected) return;
    context.value = message;
    ready.value = true;
    observer = new MutationObserver(() => prefillDimensions());
    observer.observe(root.value, { childList: true, subtree: true });
    prefillDimensions();
});
onBeforeUnmount(() => observer?.disconnect());

function prefillDimensions(reset = false) {
    for (const [fieldname, value] of Object.entries(context.value.defaults)) {
        const control = root.value?.querySelector(`.dimension-control-${fieldname} .frappe-control`)?.fieldobj;
        if (!control || (!reset && initializedControls.has(control))) continue;
        initializedControls.add(control);
        if (reset || !control.get_value()) control.set_value(value);
    }
}

async function itemAdded() {
    changed();
    await nextTick();
    prefillDimensions(true);
}

function recalculate() {
    let quantity = 0;
    let amount = 0;
    for (const group of items.value) {
        for (const entry of group.items) {
            for (const cell of Object.values(entry.values)) {
                if (!cell) continue;
                cell.amount = flt(cell.qty) * flt(cell.rate);
                quantity += flt(cell.qty);
                amount += cell.amount;
            }
        }
    }
    return { total_qty: quantity,
        [props.mode.startsWith('dc') ? 'total_declared_value' : 'total_amount']: amount };
}

function changed() {
    props.frm.set_value(recalculate());
    props.frm.dirty();
}

function removeAll() {
    items.value = [];
    changed();
}

function addSplit(groupIndex, rowIndex) {
    const group = items.value[groupIndex];
    const entry = JSON.parse(JSON.stringify(group.items[rowIndex]));
    delete entry.row_index;
    for (const [size, cell] of Object.entries(entry.values)) {
        if (!cell || !(flt(cell.qty) > 0 || cell.is_prefilled || cell.name)) {
            entry.values[size] = null;
            continue;
        }
        Object.assign(cell, { qty: 0, amount: 0, is_prefilled: 1 });
        delete cell.name;
    }
    group.items.splice(rowIndex + 1, 0, entry);
    changed();
}

function showSplitDialog() {
    const lines = items.value.flatMap((group, groupIndex) => group.items.map((entry, rowIndex) => ({
        label: `${groupIndex + 1}.${rowIndex + 1} ${entry.name} ${Object.values(entry.attributes || {}).join(' / ')}`,
        value: `${groupIndex}:${rowIndex}`,
    })));
    if (!lines.length) return frappe.msgprint(__('Add an item before splitting.'));
    const dialog = new frappe.ui.Dialog({ title: __('Add Split'),
        fields: [{ fieldname: 'line', fieldtype: 'Select', label: __('Line'), options: lines, reqd: 1 }],
        primary_action_label: __('Add Split'),
        primary_action({ line }) {
            addSplit(...line.split(':').map(Number));
            dialog.hide();
        },
    });
    dialog.show();
}

function load_data(data) {
    items.value = JSON.parse(JSON.stringify(data || []));
    const link = { grn_po: 'purchase_order_item', dc_return: 'against_dc_item' }[props.mode];
    for (const group of items.value) {
        for (const entry of group.items) {
            for (const [key, cell] of Object.entries(entry.values)) {
                if (!cell) continue;
                if (cell.__islocal || cell.name?.startsWith('new-')) delete cell.name;
                if (link && !cell[link]) entry.values[key] = null;
            }
        }
    }
    recalculate();
}

function get_items() { return items.value; }
function update_status() { editable.value = props.frm.doc.docstatus === 0; }
defineExpose({ get_items, load_data, update_status });
</script>

<style scoped>
.mgk-picker-only :deep(.table-responsive) { display: none; }
</style>
