<script setup>
import { t } from "../shell/terminology.js"
defineProps({ error: { type: Error, default: null } })
function reload() { window.location.reload() }
</script>

<template>
	<div class="error-state" role="alert">
		<h2>{{ t("Unable to load book") }}</h2><p>{{ error?.message || t("Please try again.") }}</p>
		<button class="button secondary" type="button" @click="reload">{{ t("Retry") }}</button>
	</div>
</template>
