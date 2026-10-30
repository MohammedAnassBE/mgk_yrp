import { bookManifest, manifestByType } from "../books/manifest.js"

export const defaultBlocks = bookManifest.map(({ key, type }) => ({ id: key, type }))

export function getHomeBlocks(boot = globalThis.window?.frappe?.boot || {}, registry = manifestByType) {
	const home = boot.ui_config?.config?.screens?.home || {}
	const configured = Array.isArray(home.blocks) ? home.blocks : []
	const registered = configured.filter((block) => block && Object.hasOwn(registry, block.type))
	const selected = registered.length ? registered : defaultBlocks
	const hidden = home.hidden || {}
	return selected.filter((block) => hidden[block.id] !== true).map((block) => ({ ...block }))
}
