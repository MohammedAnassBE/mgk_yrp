import json

import frappe
from frappe import _
from frappe.utils import cint, cstr, strip_html

DEFAULT_PAGE_LENGTH = 10
MAX_PAGE_LENGTH = 50
MAX_VALUE_LENGTH = 80
VERSION_BATCH = 50
MAX_SCANNED_VERSIONS = 500
DOCSTATUS_EVENTS = {1: "submitted", 2: "cancelled"}


@frappe.whitelist()
def get_document_activity(
	doctype: str, name: str, start: int = 0, page_length: int = DEFAULT_PAGE_LENGTH
) -> dict:
	"""Created/modified stamps and a page of parsed Version history for one document."""
	if not frappe.has_permission(doctype, "read", name):
		frappe.throw(_("Not permitted to read {0} {1}.").format(_(doctype), name), frappe.PermissionError)
	meta = frappe.get_meta(doctype)
	stamp_fields = ["owner", "creation", "modified", "modified_by"]
	if meta.has_field("amended_from"):
		stamp_fields.append("amended_from")
	stamps = frappe.db.get_value(doctype, name, stamp_fields, as_dict=True)
	if not stamps:
		frappe.throw(_("{0} {1} not found.").format(_(doctype), name), frappe.DoesNotExistError)

	start, page_length = max(cint(start), 0), min(max(cint(page_length), 1), MAX_PAGE_LENGTH)
	entries, next_start, has_more = get_version_page(meta, name, start, page_length)
	full_names = get_full_names({stamps.owner, stamps.modified_by, *(entry["user"] for entry in entries)})
	for entry in entries:
		entry["user_name"] = full_names.get(entry["user"], entry["user"])
	return {
		"created": {
			"user": stamps.owner,
			"user_name": full_names.get(stamps.owner, stamps.owner),
			"at": cstr(stamps.creation),
			"amended_from": stamps.get("amended_from") or None,
		},
		"modified": {
			"user": stamps.modified_by,
			"user_name": full_names.get(stamps.modified_by, stamps.modified_by),
			"at": cstr(stamps.modified),
		},
		"versions": entries,
		"has_more": has_more,
		"next_start": next_start,
	}


def get_version_page(meta, name: str, start: int, page_length: int) -> tuple[list, int, bool]:
	"""Up to `page_length` visible entries from `start`, skipping Versions with nothing the user may see."""
	parser = VersionParser(meta)
	entries, offset, has_more = [], start, False
	while len(entries) < page_length and offset - start < MAX_SCANNED_VERSIONS:
		rows = frappe.get_all(
			"Version",
			filters={"ref_doctype": meta.name, "docname": name},
			fields=["name", "owner", "creation", "data"],
			order_by="creation desc, name desc",
			start=offset,
			limit=VERSION_BATCH + 1,
		)
		batch = rows[:VERSION_BATCH]
		for index, row in enumerate(batch):
			if len(entries) == page_length:
				return entries, offset, len(rows) > VERSION_BATCH or any(map(parser.parse, batch[index:]))
			offset += 1
			if entry := parser.parse(row):
				entries.append(entry)
		has_more = len(rows) > VERSION_BATCH
		if not has_more:
			break
	return entries, offset, has_more


def get_full_names(users: set) -> dict:
	users = sorted(user for user in users if user)
	if not users:
		return {}
	rows = frappe.get_all("User", filters={"name": ("in", users)}, fields=["name", "full_name"])
	return {row.name: row.full_name or row.name for row in rows}


class VersionParser:
	"""Turns Version `data` JSON into display-ready entries using the document's field labels."""

	def __init__(self, meta):
		self.meta = meta
		self.readable_levels = {meta.name: set(meta.get_permlevel_access("read"))}

	def parse(self, version) -> dict | None:
		data = parse_version_data(version.get("data"))
		entry = {
			"name": version.get("name"),
			"user": version.get("owner"),
			"at": cstr(version.get("creation")),
			"events": [],
			"via": updater_label(data.get("updater_reference")),
			"amended_from": None,
			"changes": [],
			"rows_added": self.count_rows(data.get("added")),
			"rows_removed": self.count_rows(data.get("removed")),
			"row_changes": self.parse_row_changes(data.get("row_changed")),
		}
		for fieldname, old, new, *_rest in data.get("changed") or []:
			self.add_change(entry, fieldname, old, new)
		if data.get("created_by") and data.get("updater_reference"):
			entry["events"].append("created")
		return (
			entry
			if any(entry[key] for key in ("events", "changes", "rows_added", "rows_removed", "row_changes"))
			else None
		)

	def add_change(self, entry: dict, fieldname: str, old, new) -> None:
		if fieldname == "docstatus":
			if event := DOCSTATUS_EVENTS.get(cint(new)):
				entry["events"].append(event)
		elif fieldname == "amended_from" and new:
			entry["events"].append("amended")
			entry["amended_from"] = new
		elif field := self.get_visible_field(self.meta, fieldname):
			entry["changes"].append(field_change(field, old, new))

	def count_rows(self, rows) -> list[dict]:
		counts = {}
		for row in rows or []:
			if field := self.get_visible_field(self.meta, row[0]):
				counts.setdefault(field.fieldname, {"table": field_label(field), "count": 0})["count"] += 1
		return list(counts.values())

	def parse_row_changes(self, rows) -> list[dict]:
		out = []
		for table_fieldname, index, _row_name, row_changes in rows or []:
			table_field = self.get_visible_field(self.meta, table_fieldname)
			if not table_field or not table_field.options:
				continue
			child_meta = frappe.get_meta(table_field.options)
			changes = [
				field_change(field, old, new)
				for fieldname, old, new in row_changes
				if (field := self.get_visible_field(child_meta, fieldname))
			]
			if changes:
				out.append({"table": field_label(table_field), "row": cint(index) + 1, "changes": changes})
		return out

	def get_visible_field(self, meta, fieldname):
		field = meta.get_field(fieldname)
		if not field or (field.hidden and not field.get("show_on_timeline")):
			return None
		return field if cint(field.permlevel) in self.get_readable_levels(meta) else None

	def get_readable_levels(self, meta) -> set:
		if meta.name not in self.readable_levels:
			self.readable_levels[meta.name] = set(
				meta.get_permlevel_access("read", parenttype=self.meta.name)
			)
		return self.readable_levels[meta.name]


def parse_version_data(raw) -> dict:
	if not raw:
		return {}
	data = json.loads(raw) if isinstance(raw, str) else raw
	return data if isinstance(data, dict) else {}


def field_label(field) -> str:
	return _(field.label) if field.label else field.fieldname.replace("_", " ").title()


def field_change(field, old, new) -> dict:
	return {
		"label": field_label(field),
		"fieldtype": field.fieldtype,
		"old": display_value(old),
		"new": display_value(new),
	}


def display_value(value):
	if value is None or isinstance(value, bool | int | float):
		return value
	text = strip_html(cstr(value)).strip()
	return text if len(text) <= MAX_VALUE_LENGTH else f"{text[: MAX_VALUE_LENGTH - 1]}…"


def updater_label(reference) -> str | None:
	if not isinstance(reference, dict) or not reference:
		return None
	return (
		reference.get("label")
		or " ".join(filter(None, [reference.get("doctype"), reference.get("docname")]))
		or None
	)
