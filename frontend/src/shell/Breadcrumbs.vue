<script setup>
import { t } from "./terminology.js"
defineProps({ items: { type: Array, default: () => [] } })
</script>

<template>
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		<RouterLink to="/">{{ t("All books") }}</RouterLink>
		<template v-for="(item, index) in items" :key="index">
			<span aria-hidden="true">›</span>
			<RouterLink v-if="item.to" :to="item.to">{{ t(item.label) }}</RouterLink>
			<span v-else aria-current="page">{{ t(item.label) }}</span>
		</template>
	</nav>
</template>
