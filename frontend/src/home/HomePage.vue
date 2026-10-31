<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue"
import { bookRegistry } from "../books/registry.js"
import { getHomeBlocks } from "../layout/homeLayout.js"
import { canReadBook } from "../permissions/usePermissions.js"
import { getCounts } from "../api/client.js"
import { subscribeDoctype, onReconnect } from "../realtime/socket.js"
import { trailingTask } from "../list/listQuery.js"
import CardLoading from "../shared/CardLoading.vue"
import CardError from "../shared/CardError.vue"

const blocks = getHomeBlocks().filter((block) => canReadBook(bookRegistry[block.type]))
const components = Object.fromEntries(blocks.map((block) => [block.type, defineAsyncComponent({
	loader: bookRegistry[block.type].card,
	loadingComponent: CardLoading,
	errorComponent: CardError,
	delay: 0,
})]))
const bookBlocks = computed(() => blocks.filter((block) => bookRegistry[block.type].presentation === "book"))
const actionBlocks = computed(() => blocks.filter((block) => bookRegistry[block.type].presentation === "action"))
const counts = ref({})
const loading = ref(bookBlocks.value.length > 0)
const error = ref("")
let sequence = 0

async function loadCounts() {
	const current = ++sequence
	const types = [...new Set(bookBlocks.value.map((block) => block.type))]
	if (!types.length) { loading.value = false; return }
	loading.value = true
	error.value = ""
	try {
		const values = await getCounts(types.map((type) => ({ doctype: bookRegistry[type].doctype, filters: bookRegistry[type].countFilters || [] })))
		if (current === sequence) counts.value = Object.fromEntries(types.map((type, index) => [type, values[index]]))
	} catch (cause) {
		if (current === sequence) error.value = cause.message
	} finally {
		if (current === sequence) loading.value = false
	}
}
const refresh = trailingTask(loadCounts, 500)
let disposers = []
onMounted(() => {
	const doctypes = new Set(bookBlocks.value.map((block) => bookRegistry[block.type].doctype))
	disposers = [...[...doctypes].map((doctype) => subscribeDoctype(doctype, refresh)), onReconnect(loadCounts)]
	loadCounts()
})
onBeforeUnmount(() => { sequence++; refresh.cancel(); disposers.forEach((dispose) => dispose()) })
</script>

<template>
	<section class="page home-page">
		<header class="home-heading">
			<div class="heading-copy">
				<div class="eyebrow">MGK daily work</div>
				<h1>Your Digital Books</h1>
				<p>Open a book to continue your daily work.</p>
			</div>
			<nav v-if="actionBlocks.length" class="heading-actions home-heading-actions" aria-label="Quick links">
				<component :is="components[block.type]" v-for="block in actionBlocks" :key="block.id" />
			</nav>
		</header>
		<div v-if="error" class="error-state" role="alert">
			<h2>Unable to load record counts</h2><p>{{ error }}</p>
			<button class="button secondary" type="button" @click="loadCounts">Retry</button>
		</div>
		<div v-if="bookBlocks.length" class="group-grid" aria-label="Digital books">
			<component :is="components[block.type]" v-for="block in bookBlocks" :key="block.id"
				:count="counts[block.type] ?? null" :loading="loading" :failed="Boolean(error)" />
		</div>
		<div v-if="!blocks.length" class="empty-state compact">
			<i class="pi pi-book" aria-hidden="true" /><h2>No books to show</h2>
			<p>Your layout and permissions have no visible books. Contact your administrator to update your access or layout.</p>
		</div>
	</section>
</template>
