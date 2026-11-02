import json
import re
from pathlib import Path

import frappe

TERMINOLOGY = "MGK Workspace"
CACHE_KEY = "mgk_ui_terms"
REALTIME_EVENT = "mgk_ui_terms_updated"
DEFAULT_TERMS_DIR = Path(__file__).parent / "default_terms"


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
	terms = {
		term_key(english): {"source": english, "ta": tamil} for english, tamil in get_default_terms().items()
	}
	for row in get_term_rows():
		if row.term_key and row.source_text:
			terms[row.term_key] = {"source": row.source_text, "ta": row.tamil_text or ""}
	return terms


def get_terms():
	"""Term key to `{source, ta}`: the shipped defaults overlaid with the editable terminology rows."""
	return frappe.cache.get_value(CACHE_KEY, generator=build_terms)


@frappe.whitelist()
def get_ui_terms():
	return get_terms()


def get_tamil_labels():
	"""Normalized English to Tamil, for lookups by English text."""
	return {normalize(row["source"]): row["ta"] for row in get_terms().values() if row.get("ta")}


def translate(english, tamil=1):
	"""Tamil for an English text when `tamil` is set and a term exists, else the English text."""
	if not tamil:
		return english
	return get_tamil_labels().get(normalize(english)) or english


def seed_terms():
	"""Add missing default terms to the MGK terminology; existing rows and user edits are never changed."""
	if not frappe.db.exists("YRP UI Layout", TERMINOLOGY):
		return
	if frappe.db.exists("YRP UI Terminology", TERMINOLOGY):
		doc = frappe.get_doc("YRP UI Terminology", TERMINOLOGY)
	else:
		doc = frappe.get_doc({"doctype": "YRP UI Terminology", "ui_layout": TERMINOLOGY})
	keys = {row.term_key for row in doc.terms}
	sources = {normalize(row.source_text) for row in doc.terms}
	missing = {
		english: tamil
		for english, tamil in get_default_terms().items()
		if term_key(english) not in keys and normalize(english) not in sources
	}
	for english, tamil in missing.items():
		doc.append("terms", {"term_key": term_key(english), "source_text": english, "tamil_text": tamil})
	if missing or doc.is_new():
		doc.save(ignore_permissions=True)


def terms_changed(doc=None, method=None):
	if doc and doc.name != TERMINOLOGY:
		return
	frappe.cache.delete_value(CACHE_KEY)
	frappe.publish_realtime(REALTIME_EVENT, {}, after_commit=True)
