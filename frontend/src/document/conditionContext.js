const numberFormats = {
	"#,###.##": [".", ","], "#.###,##": [",", "."],
	"# ###.##": [".", " "], "# ###,##": [",", " "],
	"#'###.##": [".", "'"], "#, ###.##": [".", ", "],
	"#,##,###.##": [".", ","], "#,###.###": [".", ","],
	"#.###": ["", "."], "#,###": ["", ","],
}

function cint(value, fallback = 0) {
	if (typeof value === "boolean") return Number(value)
	const number = parseInt(String(value).replace(/^0+(?=.)/, ""), 10)
	return Number.isNaN(number) ? fallback : number
}

function roundScaled(number, precision, method) {
	if (method === "Banker's Rounding (legacy)") {
		number = Number(number.toFixed(8))
		const floor = Math.floor(number)
		return !precision && number - floor === 0.5 ? floor + floor % 2 : Math.round(number)
	}
	const epsilon = 2 ** (Math.log2(number) - 52)
	if (method === "Commercial Rounding") return Math.round(number + (epsilon < 0.25 ? epsilon : 0))
	if (method !== "Banker's Rounding") throw new Error(`Unknown rounding method ${method}`)
	const floor = Math.floor(number)
	const fraction = number - floor
	const tie = epsilon < 0.5 ? Math.abs(fraction - 0.5) < epsilon : fraction === 0.5
	return tie ? floor + floor % 2 : Math.round(number)
}

function parseNumber(value, format) {
	value = String(value)
	const parts = value.split(" ")
	if (parts.length > 1 && Number.isNaN(parseFloat(parts[0]))) value = parts.at(-1)
	const [decimal, group] = numberFormats[format] || numberFormats["#,###.##"]
	value = value.split(group).join("")
	if (decimal && decimal !== ".") value = value.replace(decimal, ".")
	return parseFloat(value) || 0
}

function flt(value, decimals, format = "#,###.##", method = "Banker's Rounding (legacy)") {
	if (value == null || value === "") return 0
	if (typeof value !== "number") value = parseNumber(value, format)
	if (decimals == null) return value
	const multiplier = 10 ** cint(decimals)
	const rounded = roundScaled(Math.abs(value) * multiplier, decimals, method)
	return (value < 0 ? -rounded : rounded) / multiplier
}

export function conditionContext(doc, options = {}) {
	const current = globalThis.window?.frappe || globalThis.frappe || {}
	const boot = options.boot || current.boot || {}
	const cstr = (value) => value == null ? "" : String(value)
	return {
		doc,
		parent: options.parent || doc,
		in_list: (list, item) => list.includes(item),
		cint,
		flt: (value, decimals, format, method) => flt(value, decimals,
			format || boot.sysdefaults?.number_format, method || boot.sysdefaults?.rounding_method),
		cstr,
		is_null: (value) => value == null || cstr(value).trim() === "" ? true : undefined,
		frappe: { ...current, boot, user_roles: boot.user?.roles || boot.roles || current.user_roles || [],
			session: { ...current.session, user: boot.user?.name || boot.session?.user || current.session?.user } },
	}
}
