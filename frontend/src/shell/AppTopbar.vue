<script setup>
import { computed, ref } from "vue"
import { callMethod } from "../api/client.js"
import { useConnectionState } from "../realtime/useRealtime.js"
import { isTamil, setLanguage } from "./displayLanguage.js"

defineProps({ title: { type: String, required: true } })
const user = window.frappe?.boot?.user || {}
const userName = user.full_name || user.name || "MGK"
const initials = computed(() => userName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase())
const signingOut = ref(false)
const error = ref("")
const connectionState = useConnectionState()

async function signOut() {
	signingOut.value = true
	error.value = ""
	try {
		await callMethod("logout")
		window.location.assign("/login?redirect-to=/web")
	} catch (cause) {
		error.value = cause.message
		signingOut.value = false
	}
}
</script>

<template>
	<header class="ops-topbar">
		<RouterLink class="brand" to="/" aria-label="Go to all books">
			<span class="brand-mark">MGK</span>
			<span class="brand-copy"><strong>MGK</strong><small>Operations Workspace</small></span>
		</RouterLink>
		<span class="topbar-divider" aria-hidden="true" />
		<div class="topbar-context"><strong>{{ title }}</strong></div>
		<div class="topbar-actions">
			<div class="language-toggle" role="group" aria-label="Master name language">
				<button type="button" :class="{ active: !isTamil }" :aria-pressed="!isTamil" @click="setLanguage('en')">English</button>
				<button type="button" lang="ta" :class="{ active: isTamil }" :aria-pressed="isTamil" @click="setLanguage('ta')">தமிழ்</button>
			</div>
			<span class="live-chip" :class="{ offline: connectionState === 'OFFLINE' }" role="status">{{ connectionState }}</span>
			<span class="avatar" :title="userName" :aria-label="userName">{{ initials }}</span>
			<button class="icon-button" type="button" title="Log out" aria-label="Log out" :disabled="signingOut" @click="signOut">
				<i :class="signingOut ? 'pi pi-spin pi-spinner' : 'pi pi-sign-out'" aria-hidden="true" />
			</button>
		</div>
	</header>
	<div v-if="error" class="shell-error" role="alert">{{ error }} <button class="button secondary small" type="button" @click="signOut">Retry logout</button></div>
</template>
