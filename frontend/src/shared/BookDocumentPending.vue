<script setup>
import { computed } from "vue"
import { useRoute } from "vue-router"
import Breadcrumbs from "../shell/Breadcrumbs.vue"

const props = defineProps({ book: { type: Object, required: true } })
const route = useRoute()
const label = computed(() => route.params.name || `New ${props.book.label}`)
</script>

<template>
	<section class="page">
		<Breadcrumbs :items="[{ label: book.label, to: book.routePath }, { label }]" />
		<header class="page-heading"><span class="book-identity" :class="book.cover">{{ book.code }}</span><div class="heading-copy"><div class="eyebrow">{{ book.label }}</div><h1>{{ label }}</h1></div><div class="heading-actions"><RouterLink class="button secondary" :to="book.routePath">← Back to list</RouterLink></div></header>
		<div class="empty-state compact"><i class="pi pi-file" aria-hidden="true" /><h2>Document pages are coming next</h2><p>The list is ready. Document viewing and entry will be available in the document wave.</p></div>
	</section>
</template>
