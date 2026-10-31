<script setup>
import ListView from "../../list/ListView.vue"
import book from "./config.js"
</script>

<template>
	<ListView :doctype="book.doctype" :title="book.label" :tabs="book.tabs" :default-columns="book.defaultColumns"
		:status-field="book.statusField" :column-labels="book.columnLabels" :related-doctypes="book.relatedDoctypes"
		:document-route="book.routePath" :allow-create="book.allowCreate" layout="split" :bulk-actions="book.bulkActions || []" />
</template>
