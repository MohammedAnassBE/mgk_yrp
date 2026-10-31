<script setup>
import ListView from "../../list/ListView.vue"
import book from "./config.js"
</script>

<template>
	<ListView layout="split" :extra-fields="book.extraFields" :bulk-actions="book.bulkActions || []" :doctype="book.doctype" :title="book.label" :tabs="book.tabs" :default-columns="book.defaultColumns"
		:status-field="book.statusField" :status-label="book.statusLabel" :column-labels="book.columnLabels" :related-doctypes="book.relatedDoctypes"
		:document-route="book.routePath" :create-route="`${book.routePath}/new`" />
</template>
