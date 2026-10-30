<script setup>
defineProps({ book: { type: Object, required: true }, count: { type: Number, default: null }, loading: Boolean, failed: Boolean })
</script>

<template>
	<RouterLink class="group-card" :to="book.routePath">
		<div class="group-card-head">
			<span class="group-code" :class="book.cover">{{ book.code }}</span>
			<div class="group-copy">
				<strong>{{ book.label }}</strong>
				<small>{{ book.description }}</small>
			</div>
			<span class="group-record-count" :aria-busy="loading">
				<span v-if="loading"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> Counting…</span>
				<span v-else-if="failed">Count unavailable</span>
				<span v-else>{{ count ?? 0 }} records</span>
			</span>
		</div>
		<div class="group-card-foot"><span>Open book</span><strong aria-hidden="true">›</strong></div>
		<span class="direct-card-rail" :class="book.cover" />
	</RouterLink>
</template>
