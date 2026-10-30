<template>
    <div class="mgk-attribute-columns">
        <div v-for="(group, groupIndex) in props.items" :key="groupIndex" class="table-responsive">
            <table v-if="group.items.length" class="table table-sm table-bordered">
                <thead><tr>
                    <th v-if="props.edit"><input type="checkbox" :aria-label="__('Select all rows')"
                        :checked="isGroupSelected(groupIndex)" @change="selectGroup(groupIndex, $event.target.checked)"></th>
                    <th>{{ __('Item') }}</th>
                    <th v-for="dimension in dimensions" :key="dimension.fieldname">{{ dimension.label }}</th>
                    <th v-for="attribute in nonPrimaryAttributes(group)" :key="attribute">{{ attribute }}</th>
                    <th v-for="size in sizes(group)" :key="size">{{ size === 'default' ? __('Quantity') : size }}</th>
                    <th v-if="props.edit">{{ __('Actions') }}</th>
                </tr></thead>
                <tbody><tr v-for="(entry, rowIndex) in group.items" :key="rowIndex">
                    <td v-if="props.edit"><input type="checkbox" :aria-label="__('Select row {0}', [rowIndex + 1])"
                        :checked="selected.includes(rowKey(groupIndex, rowIndex))"
                        @change="selectRow(groupIndex, rowIndex, $event.target.checked)"></td>
                    <td>{{ entry.name }}</td>
                    <td v-for="dimension in dimensions" :key="dimension.fieldname">
                        <select v-if="props.edit" class="form-control form-control-sm" :aria-label="dimension.label"
                            :value="entry.dimensions?.[dimension.fieldname] || ''"
                            @change="setDimension(entry, dimension.fieldname, $event.target.value)">
                            <option value=""></option>
                            <option v-for="value in dimensionValues(entry, dimension)" :key="value" :value="value">{{ value }}</option>
                        </select>
                        <span v-else>{{ entry.dimensions?.[dimension.fieldname] }}</span>
                    </td>
                    <td v-for="attribute in nonPrimaryAttributes(group)" :key="attribute">
                        <select v-if="props.edit" class="form-control form-control-sm" :aria-label="attribute"
                            :value="entry.attributes?.[attribute] || ''"
                            @change="setAttribute(entry, attribute, $event.target.value)">
                            <option value=""></option>
                            <option v-for="value in attributeValues(entry, attribute)" :key="value" :value="value">{{ value }}</option>
                        </select>
                        <span v-else>{{ entry.attributes?.[attribute] }}</span>
                    </td>
                    <td v-for="size in sizes(group)" :key="size" class="mgk-size-cell">
                        <template v-if="props.edit">
                            <input class="form-control form-control-sm" type="number" min="0" step="0.001"
                                :aria-label="__('Quantity {0}', [size])" :value="entry.values[size]?.qty ?? ''"
                                @input="setQuantity(entry, size, $event.target.value)">
                            <label v-if="props.mode !== 'plan'" class="small text-muted">
                                {{ __('Rate') }}
                                <input class="form-control form-control-sm" type="number" min="0" step="0.001"
                                    :aria-label="__('Rate {0}', [size])" :value="entry.values[size]?.rate ?? ''"
                                    @input="setRate(entry, size, $event.target.value)">
                            </label>
                        </template>
                        <template v-else>
                            <span>{{ entry.values[size]?.qty || 0 }}</span>
                            <div v-if="props.mode !== 'plan' && entry.values[size]" class="small">
                                {{ __('Rate') }}: {{ formatCurrency(entry.values[size].rate) }}
                            </div>
                        </template>
                        <div class="small text-muted">{{ entry.values[size]?.uom || entry.default_uom }}</div>
                        <div v-if="entry.uom_hint" class="small text-warning">{{ entry.uom_hint }}</div>
                        <div v-if="props.mode !== 'plan' && entry.values[size]" class="small">
                            {{ __('Amount') }}: {{ formatCurrency(entry.values[size].amount) }}
                        </div>
                    </td>
                    <td v-if="props.edit" class="text-nowrap">
                        <button type="button" class="btn btn-xs btn-default" @click="emit('split', groupIndex, rowIndex)">{{ __('Add Split') }}</button>
                        <button type="button" class="btn btn-xs btn-default" @click="removeRow(groupIndex, rowIndex)">{{ __('Remove') }}</button>
                    </td>
                </tr></tbody>
            </table>
        </div>
        <button v-if="props.edit && selected.length" type="button" class="btn btn-sm btn-danger mb-3"
            @click="removeSelected">{{ __('Remove Selected') }} ({{ selected.length }})</button>
    </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';

const props = defineProps({ items: Array, edit: Boolean, mode: String });
const emit = defineEmits(['changed', 'split']);
const options = ref({});
const dimensions = ref([]);
const dimensionOptions = ref({});
const selected = ref([]);
const pendingAttributes = new Set();
const rowKey = (groupIndex, rowIndex) => `${groupIndex}:${rowIndex}`;
const formatCurrency = value => format_currency(value);
const sizes = group => group.primary_attribute_values?.length ? group.primary_attribute_values : ['default'];

function nonPrimaryAttributes(group) {
    return [...new Set([...(group.attributes || []),
        ...group.items.flatMap(entry => Object.keys(entry.attributes || {}))])]
        .filter(attribute => attribute !== group.primary_attribute);
}

watch(() => props.items.map(nonPrimaryAttributes), async groups => {
    await Promise.all([...new Set(groups.flat())].map(loadAttribute));
}, { immediate: true, deep: true });
watch(() => props.items.map(group => group.items.slice()), () => { selected.value = []; });

async function loadAttribute(attribute) {
    if (options.value[attribute] || pendingAttributes.has(attribute)) return;
    pendingAttributes.add(attribute);
    try {
        const document = await frappe.db.get_doc('Item Attribute', attribute);
        options.value[attribute] = document.item_attribute_values.map(row => frappe.yrp.attribute_value(row.attribute_value));
    } finally {
        pendingAttributes.delete(attribute);
    }
}

onMounted(async () => {
    const { message } = await frappe.call({ method: 'yrp.stock.api.get_stock_dimensions_for_ui' });
    dimensions.value = message;
    await Promise.all(message.map(async dimension => {
        const rows = await frappe.db.get_list(dimension.options, { fields: ['name'], limit: 0 });
        dimensionOptions.value[dimension.fieldname] = rows.map(row => row.name);
    }));
});

function attributeValues(entry, attribute) {
    return [...new Set([entry.attributes?.[attribute], ...(options.value[attribute] || [])].filter(Boolean))];
}

function dimensionValues(entry, dimension) {
    return [...new Set([entry.dimensions?.[dimension.fieldname],
        ...(dimensionOptions.value[dimension.fieldname] || [])].filter(Boolean))];
}

function setAttribute(entry, attribute, value) {
    entry.attributes ||= {};
    entry.attributes[attribute] = value;
    refreshEntryUom(entry);
    emit('changed');
}

function refreshEntryUom(entry) {
    const group = props.items.find(group => group.items.includes(entry));
    const metadata = new Set(group.items.map(row => row.name)).size === 1 ? group : {};
    const dependent = metadata.dependent_attribute;
    const stage = metadata.dependent_attribute_details?.attr_list?.[entry.attributes[dependent]];
    const uom = dependent ? stage?.uom : (dependent === '' ? entry.default_uom : '');
    entry.default_uom = uom || '';
    entry.uom_hint = uom ? '' : __('UOM will be resolved from the Item when saved.');
    Object.values(entry.values).filter(Boolean).forEach(cell => { cell.uom = uom || ''; });
}

function setDimension(entry, fieldname, value) {
    entry.dimensions ||= {};
    entry.dimensions[fieldname] = value;
    emit('changed');
}

function setQuantity(entry, size, value) {
    if (!entry.values[size] && !flt(value)) return;
    entry.values[size] ||= { rate: 0 };
    Object.assign(entry.values[size], { qty: Math.max(0, flt(value)), is_prefilled: 1 });
    emit('changed');
}

function setRate(entry, size, value) {
    if (!entry.values[size] && !flt(value)) return;
    entry.values[size] ||= { qty: 0 };
    Object.assign(entry.values[size], { rate: Math.max(0, flt(value)), is_prefilled: 1 });
    emit('changed');
}

function selectRow(groupIndex, rowIndex, checked) {
    const key = rowKey(groupIndex, rowIndex);
    selected.value = selected.value.filter(value => value !== key);
    if (checked) selected.value.push(key);
}

function isGroupSelected(groupIndex) {
    return props.items[groupIndex].items.every((entry, rowIndex) => selected.value.includes(rowKey(groupIndex, rowIndex)));
}

function selectGroup(groupIndex, checked) {
    props.items[groupIndex].items.forEach((entry, rowIndex) => selectRow(groupIndex, rowIndex, checked));
}

function removeRow(groupIndex, rowIndex) {
    props.items[groupIndex].items.splice(rowIndex, 1);
    selected.value = [];
    emit('changed');
}

function removeSelected() {
    props.items.forEach((group, groupIndex) => {
        group.items = group.items.filter((entry, rowIndex) => !selected.value.includes(rowKey(groupIndex, rowIndex)));
    });
    selected.value = [];
    emit('changed');
}
</script>

<style scoped>
.mgk-size-cell { min-width: 7rem; }
select { min-width: 8rem; }
label { margin-top: 0.35rem; margin-bottom: 0; }
</style>
