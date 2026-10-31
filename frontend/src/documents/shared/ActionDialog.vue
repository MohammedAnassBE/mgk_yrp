<script setup>
import Dialog from "primevue/dialog"
import "./actionDialog.css"
defineProps({ visible: Boolean, header: { type: String, required: true }, width: { type: String, default: "min(560px, 94vw)" } })
defineEmits(["close", "show"])
</script>

<template>
	<Dialog :visible="visible" modal :header="header" class="action-dialog" :style="{ width }" @show="$emit('show')" @update:visible="(open) => !open && $emit('close')">
		<slot />
		<template #footer><slot name="footer" /></template>
	</Dialog>
</template>
