import definition from "./config.js"

export default {
	...definition,
	card: () => import("./PurchaseOrderCard.vue"),
	routes: [{
		path: definition.routePath,
		name: definition.key,
		component: () => import("./PurchaseOrderListPage.vue"),
		meta: { title: definition.label, bookType: definition.type },
	}, ...["new", ":name"].map((suffix) => ({
		path: `${definition.routePath}/${suffix}`,
		name: `${definition.key}-${suffix === "new" ? "new" : "document"}`,
		component: () => import("../../document/DocumentPage.vue"),
		props: { book: definition },
		meta: { title: definition.label, bookType: definition.type },
	}))],
}
