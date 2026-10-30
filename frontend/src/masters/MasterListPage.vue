<script setup>
import { computed } from "vue"
import { useRoute } from "vue-router"
import ListView from "../list/ListView.vue"
import NoAccess from "../shared/NoAccess.vue"
import NotFound from "../shared/NotFound.vue"
import { hasPermission } from "../permissions/usePermissions.js"
import { getMaster, canEditMaster } from "./mastersConfig.js"

const route = useRoute()
const master = computed(() => getMaster(route.params.master))
</script>

<template>
	<NotFound v-if="!master" />
	<NoAccess v-else-if="!hasPermission(master.doctype, master.permission)" />
	<ListView v-else :key="master.key" :doctype="master.doctype" :title="master.label" :default-columns="master.defaultColumns"
		:status-field="master.statusField" :column-labels="master.columnLabels" :related-doctypes="master.relatedDoctypes" :document-route="master.route"
		:create-route="`${master.route}/new`" :allow-create="canEditMaster(master)" back-route="/manage" back-label="Manage" />
</template>
