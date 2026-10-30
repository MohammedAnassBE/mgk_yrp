import { request, callRead } from "../api/client.js"
import { resourceRequest } from "./listQuery.js"

export async function getRows(doctype, parameters) {
	const { url, options } = resourceRequest(doctype, parameters)
	const result = await request(url, options)
	const rows = result.data || result.message || []
	if (["Address", "Contact"].includes(doctype) && rows.length) {
		const batches = []
		for (let start = 0; start < rows.length; start += 500) batches.push(rows.slice(start, start + 500).map((row) => row.name))
		const summaries = await Promise.all(batches.map((names) => callRead("mgk_yrp.web.master_links.get_link_summaries", { doctype, names })))
		const links = Object.assign({}, ...summaries)
		return rows.map((row) => ({ ...row, links: links[row.name] || "" }))
	}
	return rows
}

export function searchLinks(doctype, text) {
	return callRead("frappe.desk.search.search_link", { doctype, txt: text, page_length: 10 })
}
