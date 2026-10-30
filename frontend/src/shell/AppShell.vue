<script setup>
import { computed, ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import { bookRegistry } from "../books/registry.js"
import { canReadBook } from "../permissions/usePermissions.js"
import AppTopbar from "./AppTopbar.vue"
import NoAccess from "../shared/NoAccess.vue"

const route = useRoute()
const router = useRouter()
const navigationError = ref("")
const navigating = ref(false)
const hasAccess = computed(() => {
	const book = bookRegistry[route.meta.bookType]
	return !book || canReadBook(book)
})
router.beforeEach((to, from) => { navigating.value = to.path !== from.path; navigationError.value = "" })
router.afterEach(() => { navigating.value = false })
router.onError((error) => {
	navigating.value = false
	navigationError.value = error.message || "The page could not be loaded."
})
function reload() { window.location.reload() }
</script>

<template>
	<div class="ops-shell">
		<AppTopbar :title="String(route.meta.title || 'MGK')" />
		<main id="main-content" class="ops-main">
			<div v-if="navigationError" class="page">
				<div class="error-state" role="alert">
					<h2>Unable to open this page</h2><p>{{ navigationError }}</p>
					<button class="button secondary" type="button" @click="reload">Retry</button>
				</div>
			</div>
			<div v-else-if="navigating" class="page loading-state" role="status">
				<i class="pi pi-spin pi-spinner" aria-hidden="true" /> Loading page…
			</div>
			<NoAccess v-else-if="!hasAccess" />
			<RouterView v-else v-slot="{ Component }"><component :is="Component" :key="route.path" /></RouterView>
		</main>
	</div>
</template>
