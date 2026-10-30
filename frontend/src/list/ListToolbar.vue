<script setup>
defineProps({ search: String, sortField: String, sortDirection: String, filterCount: Number, sortFields: { type: Array, default: () => [] }, disabled: Boolean })
defineEmits(["search", "searchNow", "sort", "direction", "filters", "clear", "columns"])
</script>

<template>
	<div class="toolbar">
		<label class="search-box"><i class="pi pi-search" aria-hidden="true" /><input type="search" :value="search" aria-label="Search by ID" placeholder="Search by ID…" @input="$emit('search', $event.target.value)" @keydown.enter.prevent="$emit('searchNow')" /></label>
		<div class="sort-controls"><select :value="sortField" aria-label="Sort by" :disabled="disabled" @change="$emit('sort', $event.target.value)">
			<option value="modified">Last Updated</option><option value="creation">Created On</option><option value="name">ID</option>
			<option v-for="field in sortFields" :key="field.fieldname" :value="field.fieldname">{{ field.label }}</option>
		</select>
		<button class="button secondary sort-direction" type="button" :aria-label="sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'" :title="sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'" :disabled="disabled" @click="$emit('direction')"><i class="pi" :class="sortDirection === 'asc' ? 'pi-sort-amount-up-alt' : 'pi-sort-amount-down'" aria-hidden="true" /></button></div>
		<button class="button secondary" type="button" :disabled="disabled" @click="$emit('filters')"><i class="pi pi-filter" aria-hidden="true" />Filters <span v-if="filterCount" class="filter-badge">{{ filterCount }}</span></button>
		<button v-if="filterCount" class="button secondary" type="button" @click="$emit('clear')">Clear Filters</button>
		<button class="button secondary" type="button" :disabled="disabled" @click="$emit('columns')"><i class="pi pi-sliders-h" aria-hidden="true" />Columns</button>
	</div>
</template>
