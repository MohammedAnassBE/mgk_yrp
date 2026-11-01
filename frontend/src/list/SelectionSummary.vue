<script setup>
import { computed } from "vue"
import { selectionTotals } from "./useSplitSelection.js"
import { useActionRunner } from "../document/useActionRunner.js"
import ActionHost from "../document/ActionHost.vue"
import { formatFieldValue } from "../document/fieldDisplay.js"
import { hasPermissions } from "../permissions/usePermissions.js"

const props = defineProps({ rows: { type: Array, required: true }, actions: { type: Array, default: () => [] }, refresh: { type: Function, required: true } })
defineEmits(["clear"])
const totals = computed(() => selectionTotals(props.rows))
const allowedActions = computed(() => props.actions.filter((action) => !action.permission || hasPermissions(action.permission[0], action.permission.slice(1))))
const runner = useActionRunner({ reload: () => props.refresh() })
const actionLabel = (action) => action.eligible ? `${action.label} (${action.eligible(props.rows).length})` : action.label
const isActionEmpty = (action) => Boolean(action.eligible) && !action.eligible(props.rows).length
</script>

<template>
	<article class="selection-summary list-card">
		<header class="preview-head"><h2>{{ rows.length }} selected</h2><button class="button secondary" type="button" @click="$emit('clear')">Clear</button></header>
		<dl v-if="totals.hasQuantity || totals.hasAmount" class="preview-facts"><div v-if="totals.hasQuantity"><dt>Total quantity</dt><dd>{{ formatFieldValue({ fieldtype: 'Float' }, totals.quantity) }}</dd></div><div v-if="totals.hasAmount"><dt>Total amount</dt><dd>{{ formatFieldValue({ fieldtype: 'Currency' }, totals.amount) }}</dd></div></dl>
		<div class="preview-actions"><button v-for="action in allowedActions" :key="action.key" class="button secondary" :class="{ danger: action.danger }" type="button" :disabled="runner.busy.value || isActionEmpty(action)" @click="runner.run(action, { names: rows.map(row => row.name), rows })">{{ actionLabel(action) }}</button></div>
		<ActionHost :runner="runner" />
	</article>
</template>
