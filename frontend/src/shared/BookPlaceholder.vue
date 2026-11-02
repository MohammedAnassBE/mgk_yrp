<script setup>
import { t } from "../shell/terminology.js"
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
				<div class="eyebrow">{{ t(book.key === "masters" ? "Masters and access" : "MGK digital books") }}</div>
				<h1>{{ t(book.key === "masters" ? "Manage" : book.label) }}</h1>
				<p>{{ t(book.description) }}</p>
			</div>
			<div class="heading-actions"><RouterLink class="button secondary" to="/">← {{ t("Back to books") }}</RouterLink></div>
		</header>
		<div class="empty-state compact">
			<i class="pi pi-book" aria-hidden="true" />
			<h2>{{ t("List coming in the next wave") }}</h2>
			<p>{{ t("This book is ready for its list.") }}</p>
		</div>
		<ul v-if="book.key === 'masters'" class="available-masters" aria-label="Masters you can read">
			<li v-for="master in allowedMasters" :key="master.key">{{ t(master.label) }}</li>
		</ul>
	</section>
</template>
