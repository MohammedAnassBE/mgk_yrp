<script setup>
import { computed } from "vue"
import InputNumber from "primevue/inputnumber"

const props = defineProps({ rows: { type: Array, required: true }, editable: Boolean, busy: Boolean })
defineEmits(["quantity"])
const attributes = computed(() => [...new Set(props.rows.flatMap((row) => Object.keys(row.attributes)))])
</script>

<template>
	<div class="list-card table-scroll transit-items" tabindex="0" aria-label="Transfer items">
		<table>
			<thead><tr>
				<th>Item</th>
				<th v-for="attribute in attributes" :key="attribute">{{ attribute }}</th>
				<th>UOM</th><th>Quantity</th><th>Transferred Qty</th><th>Pending</th>
				<th v-if="editable">Quantity to transfer</th>
			</tr></thead>
			<tbody><tr v-for="row in rows" :key="row.source_row">
				<td>{{ row.item }}</td>
				<td v-for="attribute in attributes" :key="attribute">{{ row.attributes[attribute] || '—' }}</td>
				<td>{{ row.uom }}</td><td>{{ row.original_qty }}</td><td>{{ row.transferred_qty }}</td><td>{{ row.pending_qty }}</td>
				<td v-if="editable">
					<InputNumber :model-value="row.qty" :min="0" :max="row.pending_qty" :max-fraction-digits="6"
						:disabled="busy" :aria-label="`${row.item} quantity to transfer`" fluid
						@update:model-value="$emit('quantity', row, $event)" />
				</td>
			</tr></tbody>
		</table>
	</div>
</template>

<style scoped>
.transit-items { max-width: 100%; min-width: 0; overflow-x: auto; }
table { min-width: 640px; width: 100%; }
td:last-child { min-width: 140px; }
</style>
