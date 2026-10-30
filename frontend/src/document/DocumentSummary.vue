<script setup>
defineProps({ summary: Object, editing: Boolean, book: Object })
function value(line) {
	if (line.money) return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(line.value) || 0)
	return line.value ?? "—"
}
</script>

<template>
	<section class="order-summary-card po-totals-card">
		<header class="summary-heading">
			<span class="saved-book" :class="book.cover">{{ book.code }}</span>
			<h2>{{ summary.title }}</h2>
		</header>
		<div v-for="(line, index) in summary.lines" :key="line.label" class="summary-line" :class="{ 'grand-total': index === summary.lines.length - 1 }">
			<span>{{ line.label }}</span><strong>{{ value(line) }}</strong>
		</div>
		<template v-if="editing && summary.checklist?.length">
			<h3 class="checklist-title">Before saving</h3>
			<ul class="order-checklist">
				<li v-for="line in summary.checklist" :key="line.label"><i :class="line.complete ? 'pi pi-check' : 'pi pi-circle'" /> {{ line.label }}</li>
			</ul>
		</template>
	</section>
</template>
