import { openMappedDraft } from "./mappedDraft.js"

export const FORWARD_KEYS = ["create-grn", "mark-as-received", "complete-transfer", "update-plan", "create-dc", "return", "close"]

export function forwardActions(actions = []) {
	return actions.filter((action) => action.forward || FORWARD_KEYS.includes(action.key))
}

export function actionKind(action) {
	if (action.to) return "link"
	if (action.dialog) return "dialog"
	if (action.run) return "run"
	if (action.method && action.route) return "mapped"
	throw new Error(`Action ${action.key} has no handler.`)
}

export async function runAction(action, target, ctx) {
	const kind = actionKind(action)
	if (kind === "link") return ctx.navigate(action.to)
	if (kind === "dialog") return ctx.openDialog(action, target)
	if (kind === "mapped") return openMappedDraft(action, target.doc.name, { call: ctx.call, navigate: ctx.navigate, isCurrent: ctx.isCurrent || (() => true) })
	const text = typeof action.confirm === "function" ? action.confirm(target.doc) : action.confirm
	if (text && !(await ctx.confirm(text))) return
	if (ctx.isCurrent && !ctx.isCurrent()) return
	const result = await action.run(target, { call: ctx.call, navigate: ctx.navigate })
	await ctx.finished(result)
	return result
}
