<script setup>
import { computed } from "vue"
import { useRoute } from "vue-router"
import NotFound from "../shared/NotFound.vue"
import MasterEntry from "./MasterEntry.vue"
import { getMaster } from "./mastersConfig.js"

const route = useRoute()
const master = computed(() => getMaster(route.params.master))
</script>

<template>
	<NotFound v-if="!master" />
	<MasterEntry v-else :key="route.path" :master="master" />
</template>
