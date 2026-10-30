<script setup>
defineProps({ error: { type: Error, default: null } })
function reload() { window.location.reload() }
</script>

<template>
	<div class="error-state" role="alert">
		<h2>Unable to load book</h2><p>{{ error?.message || "Please try again." }}</p>
		<button class="button secondary" type="button" @click="reload">Retry</button>
	</div>
</template>
