<script setup>
import { t } from "../shell/terminology.js"
</script>

<template>
	<section class="page">
		<div class="empty-state compact">
			<i class="pi pi-search" aria-hidden="true" /><h2>{{ t("Page not found") }}</h2>
			<p>{{ t("This page is unavailable.") }}</p><RouterLink class="button secondary" to="/">{{ t("Back to books") }}</RouterLink>
		</div>
	</section>
</template>
