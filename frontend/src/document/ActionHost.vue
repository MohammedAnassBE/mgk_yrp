<script setup>
import Button from "primevue/button"
import Message from "primevue/message"
import ActionDialog from "../documents/shared/ActionDialog.vue"
defineProps({ runner: { type: Object, required: true } })
</script>

<template>
	<Message v-if="runner.error.value" severity="error" :closable="false" class="form-banner">
		<strong>Unable to complete this action</strong>
		<p class="server-error">{{ runner.error.value }}</p>
	</Message>
	<Message v-if="runner.result.value?.message" severity="success" :closable="true" class="form-banner action-result" @close="runner.result.value = null">
		{{ runner.result.value.message }}
		<template v-for="link in runner.result.value.links || []" :key="link.to">
			<a v-if="link.to.startsWith('/app/')" class="record-id" :href="link.to">{{ link.label }}</a>
			<RouterLink v-else class="record-id" :to="link.to">{{ link.label }}</RouterLink>
		</template>
	</Message>
	<component :is="runner.dialog.value.component" v-if="runner.dialog.value" :doc="runner.dialog.value.target.doc"
		:names="runner.dialog.value.target.names" :rows="runner.dialog.value.target.rows" :action="runner.dialog.value.action"
		@done="runner.dialogDone" @close="runner.dialogClosed" />
	<ActionDialog :visible="Boolean(runner.confirmation.value)" header="Please confirm" @close="runner.answer(false)">
		<p>{{ runner.confirmation.value?.text }}</p>
		<template #footer>
			<Button label="Keep working" severity="secondary" outlined @click="runner.answer(false)" />
			<Button label="Confirm" @click="runner.answer(true)" />
		</template>
	</ActionDialog>
</template>
