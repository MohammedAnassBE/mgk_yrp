<script setup>
import book from "./index.js"
</script>

<template>
	<RouterLink class="button secondary" :to="book.routePath">
		<i class="pi pi-box" aria-hidden="true" />
		{{ book.label }}
	</RouterLink>
</template>
