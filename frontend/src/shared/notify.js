const LIFE = 3000
let service = null

export function bindToast(toast) { service = toast }

function show(severity, text, life) {
	if (text) service?.add({ severity, summary: text, life })
}

export const notify = {
	success: (text) => show("success", text, LIFE),
	error: (text) => show("error", text, LIFE * 2),
}

export function actionToastText(result) {
	if (!result?.message) return ""
	const labels = (result.links || []).map((link) => link.label).filter(Boolean)
	return [result.message.replace(/[.:]\s*$/, ""), labels.join(", ")].filter(Boolean).join(": ")
}

export function documentToast(name, verb) {
	return name ? `${name} ${verb}` : verb[0].toUpperCase() + verb.slice(1)
}
