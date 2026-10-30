<script setup>
import Breadcrumbs from "./Breadcrumbs.vue"

defineProps({ title: { type: String, required: true } })
</script>

<template>
	<header class="list-page-header">
		<Breadcrumbs :items="[{ label: title }]" />
		<div v-if="$slots.default" class="list-page-actions"><slot /></div>
	</header>
</template>

<style scoped>
.list-page-header { display: flex; align-items: center; gap: 8px; min-width: 0; }
.list-page-header :deep(.breadcrumbs) { flex: 1; flex-wrap: nowrap; gap: 6px; min-width: 0; margin: 0; }
.list-page-header :deep(.breadcrumbs a) { flex-shrink: 0; font-size: 13px; }
.list-page-header :deep([aria-current="page"]) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text); font-size: 17px; font-weight: 600; }
.list-page-actions { display: flex; flex-shrink: 0; align-items: center; gap: 8px; margin-left: auto; }
.list-page-actions :deep(.button) { min-height: 38px; padding: 8px 12px; font-size: 13px; }
.list-page-actions :deep(a:not(.button)) { color: var(--color-accent); font-size: 13px; text-decoration: none; }
</style>
