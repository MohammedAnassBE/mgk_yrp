const plain = (value) => String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()

export function linkDescription(option) {
	const shown = new Set([option.value, option.label, option.tamil].map(plain).filter(Boolean))
	const parts = plain(option.description).split(/\s*,\s*/).filter((part) => part && !shown.has(part))
	return parts.join(", ")
}

/**
 * Suggestion row text: the current language's name in bold, then the other language's name,
 * then the record name when it differs from the English title, then the search description.
 */
export function linkRow(option, tamil = false) {
	const english = plain(option.label) || plain(option.value)
	const names = option.tamil ? (tamil ? [option.tamil, english] : [english, option.tamil]) : [english]
	const extra = [plain(option.value), linkDescription(option)].filter((line) => line && !names.includes(line))
	return { primary: names[0], secondary: [...names.slice(1), ...extra] }
}
