<script setup>
import { tabLabel } from "../shell/displayLanguage.js"
defineProps({ tabs: { type: Array, default: () => [] }, active: { type: String, default: "all" }, counts: { type: Object, default: () => ({}) }, total: { type: Number, default: 0 }, ready: Boolean })
defineEmits(["change"])
</script>

<template>
	<div class="list-tabs-row">
		<div v-if="tabs.length > 1" class="status-filters" aria-label="List tabs">
			<button v-for="tab in tabs" :key="tab.key" class="status-filter" :class="{ active: tab.key === active }" type="button" :aria-pressed="tab.key === active" @click="$emit('change', tab.key)">{{ tabLabel(tab) }} <span>{{ ready ? counts[tab.key] ?? 0 : '…' }}</span></button>
		</div>
		<span class="list-record-count" role="status">{{ ready ? `${total} records` : 'Counting…' }}</span>
	</div>
</template>
