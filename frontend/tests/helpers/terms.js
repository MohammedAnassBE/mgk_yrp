import { readdirSync, readFileSync } from "node:fs"

const folder = new URL("../../../mgk_yrp/terminology/default_terms/", import.meta.url)

/** The shipped default terms in the boot `terms` shape, keyed by English for tests. */
export function defaultTerms() {
	const terms = {}
	for (const file of readdirSync(folder).filter((name) => name.endsWith(".json")).sort()) {
		for (const [source, ta] of Object.entries(JSON.parse(readFileSync(new URL(file, folder), "utf8")))) terms[source] = { source, ta }
	}
	return terms
}
