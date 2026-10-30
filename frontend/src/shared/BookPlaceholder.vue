<script setup>
import { readableMasters } from "../permissions/usePermissions.js"
import Breadcrumbs from "../shell/Breadcrumbs.vue"

defineProps({ book: { type: Object, required: true } })
const allowedMasters = readableMasters()
</script>

<template>
	<section class="page">
		<Breadcrumbs :items="[{ label: book.key === 'masters' ? 'Manage' : book.label }]" />
		<header class="page-heading">
			<span class="book-identity" :class="book.cover">{{ book.code }}</span>
			<div class="heading-copy">
				<div class="eyebrow">{{ book.key === "masters" ? "Masters and access" : "MGK digital books" }}</div>
				<h1>{{ book.key === "masters" ? "Manage" : book.label }}</h1>
				<p>{{ book.description }}</p>
			</div>
			<div class="heading-actions"><RouterLink class="button secondary" to="/">← Back to books</RouterLink></div>
		</header>
		<div class="empty-state compact">
			<i class="pi pi-book" aria-hidden="true" />
			<h2>List coming in the next wave</h2>
			<p>This book is ready for its list.</p>
		</div>
		<ul v-if="book.key === 'masters'" class="available-masters" aria-label="Masters you can read">
			<li v-for="master in allowedMasters" :key="master.key">{{ master.label }}</li>
		</ul>
	</section>
</template>
