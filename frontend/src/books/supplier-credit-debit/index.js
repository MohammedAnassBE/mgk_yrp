import definition from "./config.js"

export default {
	...definition,
	card: () => import("./SupplierCreditDebitCard.vue"),
	routes: [{
		path: definition.routePath,
		name: definition.key,
		component: () => import("./SupplierCreditDebitListPage.vue"),
		meta: { title: definition.label, bookType: definition.type },
	}, ...["new", ":name"].map((suffix) => ({
		path: `${definition.routePath}/${suffix}`,
		name: `${definition.key}-${suffix === "new" ? "new" : "document"}`,
		component: () => import("../../document/DocumentPage.vue"),
		props: { book: definition },
		meta: { title: definition.label, bookType: definition.type },
	}))],
}
