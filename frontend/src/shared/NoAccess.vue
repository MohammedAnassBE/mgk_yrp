<script setup>
import { t } from "../shell/terminology.js"
</script>

<template>
	<section class="page">
		<div class="empty-state compact">
			<i class="pi pi-lock" aria-hidden="true" />
			<h2>{{ t("No access") }}</h2>
			<p>{{ t("You do not have permission to read this book.") }}</p>
			<RouterLink class="button secondary" to="/">{{ t("Back to books") }}</RouterLink>
		</div>
	</section>
</template>
