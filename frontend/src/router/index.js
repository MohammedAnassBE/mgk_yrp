import { createRouter, createWebHistory } from "vue-router"
import { books } from "../books/registry.js"

const router = createRouter({
	history: createWebHistory("/web/"),
	routes: [
		{ path: "/", name: "home", component: () => import("../home/HomePage.vue"), meta: { title: "Your Digital Books" } },
		...books.flatMap((book) => book.routes),
		{ path: "/:pathMatch(.*)*", name: "not-found", component: () => import("../shared/NotFound.vue"), meta: { title: "Page not found" } },
	],
	scrollBehavior(to, from) { return to.path === from.path ? false : { top: 0 } },
})

export default router
