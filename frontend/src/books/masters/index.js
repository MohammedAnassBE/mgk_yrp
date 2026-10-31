import definition from "./config.js"

export default {
	...definition,
	card: () => import("./MastersCard.vue"),
	routes: [{
		path: definition.routePath,
		name: definition.key,
		component: () => import("./MastersListPage.vue"),
		meta: { title: definition.label, bookType: definition.type },
	}, {
		path: "/manage/users/:name*", redirect: definition.routePath,
	}, {
		path: "/manage/:master", component: () => import("../../masters/MasterListPage.vue"), meta: { title: "Manage" },
	}, {
		path: "/manage/:master/new", component: () => import("../../masters/MasterFormPage.vue"), meta: { title: "New master" },
	}, {
		path: "/manage/:master/:name", component: () => import("../../masters/MasterFormPage.vue"), meta: { title: "Manage master" },
	}],
}
