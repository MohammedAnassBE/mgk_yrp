<script setup>
defineProps({ book: Object, doc: Object, isNew: Boolean, dirty: Boolean, back: [String, Object] })
</script>
<template>
	<header class="detail-head">
		<div class="book-entry-title">
			<RouterLink v-if="back" class="head-back" :to="back" aria-label="Back" title="Back"><i class="pi pi-arrow-left" aria-hidden="true" /></RouterLink>
			<div class="book-entry-mark" :class="book.cover">
				<small>MGK</small>
				<strong>{{ book.code }}</strong>
			</div>
			<div class="book-entry-heading">
				<div class="book-entry-kicker">
					{{ book.label }}
					·
					{{ isNew ? 'New entry' : ['Draft', 'Submitted', 'Cancelled'][doc.docstatus] }}
					<span v-if="dirty"> · Unsaved</span>
				</div>
				<h1 class="doc-hero">{{ isNew ? `Write a new ${book.label.toLowerCase()}` : Number(doc.docstatus) === 0 ? `Update ${doc.name}` : [doc.name, doc.supplier || doc.to_location].filter(Boolean).join(' · ') }}</h1>
			</div>
		</div>
		<slot />
	</header>
</template>
