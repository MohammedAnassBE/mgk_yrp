<script setup>
import { computed } from "vue"
import { hasPermission } from "../permissions/usePermissions.js"
const props = defineProps({ book: { type: Object, required: true }, count: { type: Number, default: null }, loading: Boolean, failed: Boolean })
const canCreate = computed(() => props.book.showCreate !== false && hasPermission(props.book.doctype, "create"))
</script>

<template>
	<div class="book-card">
		<RouterLink class="group-card" :to="book.homePath || book.routePath">
			<div class="group-card-head" :class="{ 'has-create': canCreate }">
				<span class="group-code" :class="book.cover">{{ book.code }}</span>
				<div class="group-copy">
					<strong>{{ book.label }}</strong>
					<small>{{ book.description }}</small>
				</div>
				<span class="group-record-count" :aria-busy="loading">
					<span v-if="loading"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> Counting…</span>
					<span v-else-if="failed">Count unavailable</span>
					<span v-else>{{ count ?? 0 }} {{ book.countLabel || 'records' }}</span>
				</span>
			</div>
			<div class="group-card-foot"><span>{{ book.openLabel || 'Open book' }}</span><strong aria-hidden="true">›</strong></div>
			<span class="direct-card-rail" :class="book.cover" />
		</RouterLink>
		<RouterLink v-if="canCreate" class="button small book-create" :class="book.cover" :to="book.newPath || `${book.routePath}/new`">+ New</RouterLink>
	</div>
</template>

<style scoped>
.book-card { position: relative; display: grid; min-width: 0; }
.has-create { padding-right: 72px; flex-wrap: wrap; }
.book-create { position: absolute; top: 20px; right: 20px; color: var(--color-card); box-shadow: var(--shadow-card); }
.book-create:hover, .book-create:focus-visible { filter: brightness(.86); box-shadow: var(--shadow-card-hover); }
@media (max-width: 760px) {
	.book-create { top: 16px; right: 16px; }
}
</style>
