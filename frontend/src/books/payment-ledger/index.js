import definition from "./config.js"

export default {
	...definition,
	routes: [{
		path: definition.routePath,
		name: definition.key,
		component: () => import("./PaymentLedgerListPage.vue"),
		meta: { title: definition.label, bookType: definition.type },
	}],
}
