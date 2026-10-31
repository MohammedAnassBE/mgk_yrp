const pad = (value) => String(value).padStart(2, "0")
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/

/** Formats a Date or ISO date/datetime string as DD-MM-YYYY (with HH:mm for datetimes). */
export function formatDate(value, { withTime = false } = {}) {
	if (value == null || value === "") return ""
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return ""
		const date = `${pad(value.getDate())}-${pad(value.getMonth() + 1)}-${value.getFullYear()}`
		return withTime ? `${date} ${pad(value.getHours())}:${pad(value.getMinutes())}` : date
	}
	const match = DATE_PATTERN.exec(String(value))
	if (!match) return String(value)
	const [, year, month, day, hour, minute] = match
	const date = `${day}-${month}-${year}`
	return withTime && hour ? `${date} ${hour}:${minute}` : date
}

export function formatDatetime(value) { return formatDate(value, { withTime: true }) }

export function toIsoDate(value) {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) return ""
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}
