<script setup>
import { computed } from "vue"
import { displayName, isTamil } from "../shell/displayLanguage.js"
import { t } from "../shell/terminology.js"
const props = defineProps({ book: Object, doc: Object, isNew: Boolean, dirty: Boolean, back: [String, Object] })
const hero = computed(() => {
	const { book, doc } = props
	if (props.isNew) return isTamil.value ? `${t("New")} ${t(book.label)}` : `Write a new ${book.label.toLowerCase()}`
	if (Number(doc.docstatus) === 0) return isTamil.value ? `${doc.name} ${t("Update")}` : `Update ${doc.name}`
	return [doc.name, displayName("Supplier", doc.supplier || doc.to_location)].filter(Boolean).join(" · ")
})
</script>
<template>
	<header class="detail-head">
		<div class="book-entry-title">
			<RouterLink v-if="back" class="head-back" :to="back" :aria-label="t('Back')" :title="t('Back')"><i class="pi pi-arrow-left" aria-hidden="true" /></RouterLink>
			<div class="book-entry-mark" :class="book.cover">
				<small>MGK</small>
				<strong>{{ book.code }}</strong>
			</div>
			<div class="book-entry-heading">
				<div class="book-entry-kicker">
					{{ t(book.label) }}
					·
					{{ t(isNew ? 'New entry' : ['Draft', 'Submitted', 'Cancelled'][doc.docstatus]) }}
					<span v-if="dirty"> · {{ t('Unsaved') }}</span>
				</div>
				<h1 class="doc-hero">{{ hero }}</h1>
			</div>
		</div>
		<slot />
	</header>
</template>
