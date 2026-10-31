<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from "vue"
import Button from "primevue/button"
import Dialog from "primevue/dialog"
import { hasPermission } from "../permissions/usePermissions.js"
import { canAmendDocument, hasOpenDialog, isSaveShortcut } from "./lifecycle.js"
import { reopenConfirmation } from "../documents/delivery-challan-close/actions.js"
const props = defineProps({ doc: Object, meta: Object, dirty: Boolean, isNew: Boolean, busy: Boolean, blocked: Boolean, editing: Boolean, extraActions: { type: Array, default: () => [] } })
const emit = defineEmits(["action", "discard"])
const pending = ref(null)
const allowed = (permission) => hasPermission(props.doc.doctype, permission)
const isDraft = computed(() => Number(props.doc.docstatus) === 0)
const canSave = computed(() => isDraft.value && (props.isNew || props.dirty) && allowed(props.isNew ? "create" : "write"))
const canAmend = computed(() => !props.busy && canAmendDocument(props.doc, allowed))
const canSubmit = computed(() => isDraft.value && !props.isNew && !props.dirty && Number(props.meta?.is_submittable) && allowed("submit"))
const isClose = computed(() => props.doc.doctype === "MGK Delivery Challan Close")
function confirm() { const action = pending.value; pending.value = null; emit("action", action) }
function keydown(event) {
	if (!isSaveShortcut(event)) return
	event.preventDefault()
	if (props.busy || props.blocked || pending.value || hasOpenDialog()) return
	if (canSave.value) emit("action", "save")
	else if (canSubmit.value) pending.value = "submit"
}
onMounted(() => globalThis.window?.addEventListener?.("keydown", keydown))
onBeforeUnmount(() => globalThis.window?.removeEventListener?.("keydown", keydown))
</script>
<template>
	<div class="head-actions">
		<Button
			v-for="action in extraActions"
			:key="action.key"
			:label="action.label"
			severity="secondary"
			outlined
			size="small"
			:disabled="busy || dirty"
			@click="$emit('action', action.key)"
		/>
		<Button
			v-if="editing && dirty && !isNew"
			label="Discard changes"
			severity="secondary"
			outlined
			size="small"
			:disabled="busy"
			@click="pending = 'discard'"
		/>
		<Button
			v-if="!isNew && [0, 2].includes(Number(doc.docstatus)) && allowed('delete')"
			label="Delete"
			severity="secondary"
			outlined
			size="small"
			:disabled="busy"
			@click="pending = 'delete'"
		/>
		<Button
			v-if="Number(doc.docstatus) === 1 && allowed('cancel')"
			:label="isClose ? 'Reopen' : 'Cancel'"
			:severity="isClose ? undefined : 'secondary'"
			:outlined="!isClose"
			size="small"
			:disabled="busy || dirty"
			@click="pending = 'cancel'"
		/>
		<Button
			v-if="canAmend"
			label="Amend"
			size="small"
			:disabled="busy"
			@click="$emit('action', 'amend')"
		/>
		<Button
			v-if="canSave"
			label="Save"
			class="forward-cta"
			size="small"
			:loading="busy"
			:disabled="blocked"
			@click="$emit('action', 'save')"
		/>
		<Button
			v-else-if="canSubmit"
			label="Submit"
			class="forward-cta"
			size="small"
			:loading="busy"
			:disabled="blocked"
			@click="pending = 'submit'"
		/>
		<Dialog
			:visible="Boolean(pending)"
			modal
			:header="isClose && pending === 'cancel' ? 'Reopen Delivery Challan' : `${pending?.[0]?.toUpperCase()}${pending?.slice(1) || ''} document`"
			:style="{ width: 'min(440px, 94vw)' }"
			@update:visible="pending = null"
		>
			<p>{{ isClose && pending === 'cancel' ? reopenConfirmation(doc) : pending === 'discard' ? 'Discard your changes and reload the saved document?' : `Confirm ${pending} for ${doc.name}?` }}</p>
			<template #footer>
				<Button
					label="Keep working"
					severity="secondary"
					outlined
					@click="pending = null"
				/>
				<Button
					label="Confirm"
					:autofocus="!['cancel', 'delete', 'discard'].includes(pending)"
					:severity="['cancel', 'delete'].includes(pending) ? 'danger' : undefined"
					@click="pending === 'discard' ? ($emit('discard'), pending = null) : confirm()"
				/>
			</template>
		</Dialog>
	</div>
</template>
