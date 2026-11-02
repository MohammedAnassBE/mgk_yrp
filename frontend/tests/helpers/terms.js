import { readdirSync, readFileSync } from "node:fs"

const folder = new URL("../../../mgk_yrp/terminology/default_terms/", import.meta.url)
const keyedFile = new URL("../../../mgk_yrp/terminology/keyed_terms.json", import.meta.url)

/** The shipped default terms in the boot `terms` shape, keyed by English (keyed terms by their key) for tests. */
export function defaultTerms() {
	const terms = {}
	for (const file of readdirSync(folder).filter((name) => name.endsWith(".json")).sort()) {
		for (const [source, ta] of Object.entries(JSON.parse(readFileSync(new URL(file, folder), "utf8")))) terms[source] = { source, ta }
	}
	for (const [key, row] of Object.entries(JSON.parse(readFileSync(keyedFile, "utf8")))) terms[key] = { ...row, keyed: 1 }
	return terms
}
