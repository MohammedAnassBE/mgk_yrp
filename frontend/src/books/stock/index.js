import definition from "./config.js"

export default {
	...definition,
	card: () => import("./StockCard.vue"),
	routes: [{
		path: definition.routePath,
		name: definition.key,
		component: () => import("./StockListPage.vue"),
		meta: { title: definition.label, bookType: definition.type },
	}],
}
