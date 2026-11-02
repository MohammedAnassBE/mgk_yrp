<script setup>
import { t } from "./terminology.js"
import { computed, ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import { bookRegistry } from "../books/registry.js"
import { canReadBook } from "../permissions/usePermissions.js"
import AppTopbar from "./AppTopbar.vue"
import NoAccess from "../shared/NoAccess.vue"
import Toast from "primevue/toast"
import { onEvent } from "../realtime/socket.js"
import { refreshTerms, TERMS_EVENT } from "./terminology.js"

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
	navigationError.value = error.message || t("The page could not be loaded.")
})
function reload() { window.location.reload() }
onEvent(TERMS_EVENT, () => refreshTerms().catch(() => {}))
</script>

<template>
	<div class="ops-shell">
		<Toast position="top-right" class="app-toast" />
		<AppTopbar :title="t(String(route.meta.title || 'MGK'))" />
		<main id="main-content" class="ops-main">
			<div v-if="navigationError" class="page">
				<div class="error-state" role="alert">
					<h2>{{ t("Unable to open this page") }}</h2><p>{{ navigationError }}</p>
					<button class="button secondary" type="button" @click="reload">{{ t("Retry") }}</button>
				</div>
			</div>
			<div v-else-if="navigating" class="page loading-state" role="status">
				<i class="pi pi-spin pi-spinner" aria-hidden="true" /> {{ t("Loading page…") }}
			</div>
			<NoAccess v-else-if="!hasAccess" />
			<RouterView v-else v-slot="{ Component }"><component :is="Component" :key="route.path" /></RouterView>
		</main>
	</div>
</template>
