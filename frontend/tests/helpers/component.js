import { readFile } from "node:fs/promises"
import { createRenderer, h, nextTick } from "vue"
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc"

const vueUrl = import.meta.resolve("vue")
const stubUrl = new URL("./primeStub.js", import.meta.url).href
const emptyComponent = `data:text/javascript,export default {render:()=>null}`
const modules = new Map()

export async function loadComponent(path) {
	const url = new URL(path, import.meta.url)
	if (modules.has(url.href)) return import(modules.get(url.href))
	const { descriptor } = parse(await readFile(url, "utf8"), { filename: url.pathname })
	let content = descriptor.script || descriptor.scriptSetup
		? compileScript(descriptor, { id: url.pathname, inlineTemplate: true }).content
		: `${compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: url.pathname }).code}\nexport default { render }`
	content = content.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, "")
	const imports = [...content.matchAll(/import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g)]
	for (const [statement, binding, target] of imports) {
		let replacement
		if (target === "vue") replacement = `import ${binding} from ${JSON.stringify(vueUrl)}`
		else if (target.startsWith("primevue/")) replacement = `import { ${binding.trim()} } from ${JSON.stringify(stubUrl)}`
		else if (!target.startsWith(".")) replacement = `import ${binding} from ${JSON.stringify(import.meta.resolve(target))}`
		else {
			const dependency = new URL(target, url)
			if (target.endsWith(".vue")) {
				if (target.endsWith("FieldControl.vue")) dependency.href = emptyComponent
				else { await loadComponent(dependency); dependency.href = modules.get(dependency.href) }
			}
			replacement = `import ${binding} from ${JSON.stringify(dependency.href)}`
		}
		content = content.replace(statement, replacement)
	}
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(content).toString("base64")}`
	modules.set(url.href, moduleUrl)
	return import(moduleUrl)
}

function node(tag, text = "") {
	return { tag, text, props: {}, children: [], parent: null, listeners: {}, focus() { this.focused = true },
		get options() { return this.children.filter((child) => child.tag === "option") },
		querySelector() { return nodes(this, (child) => ["input", "textarea", "select"].includes(child.tag) && !child.props.disabled)[0] || null },
		addEventListener(name, handler) { this.listeners[name] = handler }, removeEventListener(name) { delete this.listeners[name] } }
}
const renderer = createRenderer({
	createElement: (tag) => node(tag), createText: (text) => node("text", text), createComment: () => node("comment"),
	setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
	patchProp: (node, name, previous, value) => { node.props[name] = value; if (name === "value") node.value = node._value = value },
	parentNode: (node) => node.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
	insert(node, parent, anchor) {
		if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
		node.parent = parent
		const index = anchor ? parent.children.indexOf(anchor) : -1
		parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
	},
	remove(node) { node.parent?.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
})

export async function mountComponent(path, props, plugins = []) {
	const component = (await loadComponent(path)).default
	const root = node("root")
	const app = renderer.createApp({ render: () => h(component, props) })
	plugins.forEach((plugin) => app.use(plugin))
	if (!app.component("RouterLink")) app.component("RouterLink", { props: ["to"], setup: (props, { slots }) => () => h("a", { href: props.to }, slots.default?.()) })
	app.mount(root)
	await settle()
	return { root, close: () => app.unmount() }
}

export function nodes(root, predicate) {
	return [root, ...root.children.flatMap((child) => nodes(child, () => true))].filter(predicate)
}

export function textContent(root) { return root.text + root.children.map(textContent).join("") }
export async function settle() { await nextTick(); await new Promise(setImmediate); await nextTick() }
