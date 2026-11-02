import json
import re
from pathlib import Path

import frappe

TERMINOLOGY = "MGK Workspace"
CACHE_KEY = "mgk_ui_terms"
REALTIME_EVENT = "mgk_ui_terms_updated"
DEFAULT_TERMS_DIR = Path(__file__).parent / "default_terms"
KEYED_TERMS_PATH = Path(__file__).parent / "keyed_terms.json"
SEEDED_KEYS_DEFAULT = "mgk_seeded_term_keys"


def normalize(english):
	"""Lookup form of an English text: case and spacing do not matter."""
	return " ".join(str(english or "").split()).casefold()


def term_key(english):
	"""Stable YRP UI Term key derived from the English text, e.g. `mgk.purchase_order`."""
	slug = re.sub(r"[^a-z0-9]+", "_", normalize(english).replace("'", "")).strip("_")
	if not slug:
		frappe.throw(f"Cannot derive a term key from {english!r}")
	return f"mgk.{slug if slug[0].isalpha() else 'n' + slug}"


def get_default_terms():
	"""English to Tamil defaults shipped with the app, one JSON file per area."""
	terms = {}
	for path in sorted(DEFAULT_TERMS_DIR.glob("*.json")):
		terms.update(json.loads(path.read_text(encoding="utf-8")))
	return terms


def get_keyed_terms():
	"""Defaults read by key, for English text whose meaning differs by place (status "Open" vs the Open button)."""
	return json.loads(KEYED_TERMS_PATH.read_text(encoding="utf-8"))


def get_term_rows():
	"""Rows of the MGK terminology record, empty before the layout and its terminology exist."""
	if not frappe.db.exists("YRP UI Terminology", TERMINOLOGY):
		return []
	return frappe.get_all(
		"YRP UI Term",
		filters={"parenttype": "YRP UI Terminology", "parent": TERMINOLOGY, "parentfield": "terms"},
		fields=["term_key", "source_text", "tamil_text"],
		order_by="idx asc",
	)


def build_terms():
	"""The terminology rows; the shipped defaults only stand in before the record exists."""
	keyed = get_keyed_terms()
	terms = {}
	if not frappe.db.exists("YRP UI Terminology", TERMINOLOGY):
		terms = {
			term_key(english): {"source": english, "ta": tamil}
			for english, tamil in get_default_terms().items()
		}
		terms.update({key: {**row, "keyed": 1} for key, row in keyed.items()})
	for row in get_term_rows():
		if row.term_key and row.source_text:
			terms[row.term_key] = {"source": row.source_text, "ta": row.tamil_text or ""}
			if row.term_key in keyed:
				terms[row.term_key]["keyed"] = 1
	return terms


def get_terms():
	"""Term key to `{source, ta}` from the editable terminology rows."""
	return frappe.cache.get_value(CACHE_KEY, generator=build_terms)


@frappe.whitelist()
def get_ui_terms():
	return get_terms()


def get_tamil_labels():
	"""Normalized English to Tamil, for lookups by English text; keyed terms are read only by key."""
	return {
		normalize(row["source"]): row["ta"]
		for row in get_terms().values()
		if row.get("ta") and not row.get("keyed")
	}


def translate(english, tamil=1):
	"""Tamil for an English text when `tamil` is set and a term exists, else the English text."""
	if not tamil:
		return english
	return get_tamil_labels().get(normalize(english)) or english


def seed_terms():
	"""Add default terms never seeded before; rows the user edited or deleted stay as they are."""
	if not frappe.db.exists("YRP UI Layout", TERMINOLOGY):
		return
	seeded = get_seeded_keys()
	if frappe.db.exists("YRP UI Terminology", TERMINOLOGY):
		doc = frappe.get_doc("YRP UI Terminology", TERMINOLOGY)
		if seeded is None:
			seeded = {row.term_key for row in doc.terms}
	else:
		doc = frappe.get_doc({"doctype": "YRP UI Terminology", "ui_layout": TERMINOLOGY})
		seeded = set()
	missing_rows = [row for row in get_missing_term_rows(doc.terms) if row[0] not in seeded]
	for key, english, tamil in missing_rows:
		doc.append("terms", {"term_key": key, "source_text": english, "tamil_text": tamil})
	if missing_rows or doc.is_new():
		doc.save(ignore_permissions=True)
	set_seeded_keys(seeded | {row[0] for row in missing_rows} | get_default_keys())


def get_default_keys():
	return {term_key(english) for english in get_default_terms()} | set(get_keyed_terms())


def get_seeded_keys():
	"""Keys already offered to this site, or None before the first tracked seed."""
	value = frappe.db.get_default(SEEDED_KEYS_DEFAULT)
	return set(json.loads(value)) if value else None


def set_seeded_keys(keys):
	frappe.db.set_default(SEEDED_KEYS_DEFAULT, json.dumps(sorted(keys)))


def get_missing_term_rows(rows):
	"""(key, English, Tamil) of defaults with no row yet; an English default also counts as present by its text."""
	keyed = get_keyed_terms()
	keys = {row.term_key for row in rows}
	sources = {normalize(row.source_text) for row in rows if row.term_key not in keyed}
	missing = [
		(term_key(english), english, tamil)
		for english, tamil in get_default_terms().items()
		if term_key(english) not in keys and normalize(english) not in sources
	]
	return missing + [(key, row["source"], row["ta"]) for key, row in keyed.items() if key not in keys]


def terms_changed(doc=None, method=None):
	if doc and doc.name != TERMINOLOGY:
		return
	frappe.cache.delete_value(CACHE_KEY)
	frappe.publish_realtime(REALTIME_EVENT, {}, after_commit=True)
