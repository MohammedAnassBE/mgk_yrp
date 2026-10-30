export function linkDescription(option) {
	const text = (value) => String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
	const description = text(option.description)
	return description === text(option.value) ? "" : description
}
