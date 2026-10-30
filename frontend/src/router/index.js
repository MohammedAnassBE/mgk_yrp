import { createRouter, createWebHistory } from "vue-router"
import { books } from "../books/registry.js"

const router = createRouter({
	history: createWebHistory("/web/"),
	routes: [
		{ path: "/", name: "home", component: () => import("../home/HomePage.vue"), meta: { title: "Your Digital Books" } },
		...books.flatMap((book) => book.routes),
		...["new", ":name"].map((suffix) => ({
			path: `/delivery-challan-close/${suffix}`,
			component: () => import("../document/DocumentPage.vue"),
			props: { book: { doctype: "MGK Delivery Challan Close", key: "delivery-challan-close", label: "Delivery Challan Close", code: "DC", cover: "cover-dc", routePath: "/delivery-challan-close", listPath: "/delivery-challan", description: "Review delivered value and linked GRN outputs." } },
			meta: { title: "Delivery Challan Close" },
		})),
		{ path: "/:pathMatch(.*)*", name: "not-found", component: () => import("../shared/NotFound.vue"), meta: { title: "Page not found" } },
	],
	scrollBehavior(to, from) { return to.path === from.path ? false : { top: 0 } },
})

export default router
