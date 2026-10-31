<script setup>
import BookCard from "../../shared/BookCard.vue"
import book from "./index.js"

defineProps({ count: { type: Number, default: null }, loading: Boolean, failed: Boolean })
</script>

<template>
	<BookCard :book="book" :count="count" :loading="loading" :failed="failed" />
</template>
