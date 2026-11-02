<script setup>
import { t } from "../shell/terminology.js"
import { computed } from "vue"
import { useRoute } from "vue-router"
import Breadcrumbs from "../shell/Breadcrumbs.vue"

const props = defineProps({ book: { type: Object, required: true } })
const route = useRoute()
const label = computed(() => route.params.name || `${t("New")} ${t(props.book.label)}`)
</script>

<template>
	<section class="page">
		<Breadcrumbs :items="[{ label: book.label, to: book.routePath }, { label }]" />
		<header class="page-heading"><span class="book-identity" :class="book.cover">{{ book.code }}</span><div class="heading-copy"><div class="eyebrow">{{ t(book.label) }}</div><h1>{{ label }}</h1></div><div class="heading-actions"><RouterLink class="button secondary" :to="book.routePath">← {{ t("Back to list") }}</RouterLink></div></header>
		<div class="empty-state compact"><i class="pi pi-file" aria-hidden="true" /><h2>{{ t("Document pages are coming next") }}</h2><p>{{ t("The list is ready. Document viewing and entry will be available in the document wave.") }}</p></div>
	</section>
</template>
