function parseMessage(value) {
	if (typeof value !== "string") return value
	try {
		return JSON.parse(value)
	} catch (error) {
		if (error instanceof SyntaxError) return value
		throw error
	}
}

function readableText(value) {
	return String(value)
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.trim()
}

export function serverMessages(payload = {}) {
	const raw = parseMessage(payload._server_messages || [])
	const messages = Array.isArray(raw) ? raw : [raw]
	return messages.map(parseMessage)
		.map((entry) => typeof entry === "object" && entry ? entry.message : entry)
		.filter((entry) => typeof entry === "string" && entry.trim())
		.map(readableText)
}

export function extractServerMessage(payload = {}, fallback = "The server could not complete this action.") {
	const messages = serverMessages(payload)
	if (messages.length) return messages.join("\n")
	if (typeof payload.message === "string" && payload.message) return readableText(payload.message)
	return fallback
}

export function isSessionExpired(status, payload = {}) {
	if (status === 401) return true
	const type = String(payload.exc_type || payload.exception || "")
	if (/AuthenticationError|SessionExpired/.test(type)) return true
	return status === 403 && type === "PermissionError"
		&& /Login to access/i.test(extractServerMessage(payload, ""))
}
