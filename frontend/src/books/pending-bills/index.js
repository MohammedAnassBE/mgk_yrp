import definition from "./config.js"

export default {
	...definition,
	card: () => import("./PendingBillsCard.vue"),
	routes: [{
		path: definition.routePath,
		name: definition.key,
		component: () => import("./PendingBillsListPage.vue"),
		meta: { title: definition.label, bookType: definition.type },
	}],
}
