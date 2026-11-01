import frappe
from frappe import _
from frappe.utils import cint


def get_print_restriction(doc):
	"""Return the Print Settings restriction for this document's state, if any."""
	if not doc.meta.is_submittable:
		return ""
	setting = {0: "allow_print_for_draft", 2: "allow_print_for_cancelled"}.get(cint(doc.docstatus))
	if setting and not cint(frappe.db.get_single_value("Print Settings", setting)):
		state = _("draft") if cint(doc.docstatus) == 0 else _("cancelled")
		return _("Printing {0} documents is disabled in Print Settings.").format(state)
	return ""


def get_print_formats(doctype):
	names = frappe.get_all(
		"Print Format",
		filters={"doc_type": doctype, "disabled": 0, "print_format_type": ("!=", "JS"), "raw_printing": 0},
		pluck="name",
		order_by="name asc",
	)
	return [*[name for name in names if name != "Standard"], "Standard"]


@frappe.whitelist()
def get_print_options(doctype: str, name: str) -> dict:
	doc = frappe.get_doc(doctype, name)
	frappe.has_permission(doctype, "print", doc, throw=True)
	if restriction := get_print_restriction(doc):
		frappe.throw(restriction)
	formats = get_print_formats(doctype)
	default_format = frappe.get_meta(doctype).default_print_format
	letter_heads = frappe.get_all("Letter Head", filters={"disabled": 0}, pluck="name", order_by="name asc")
	default_letter_head = doc.get("letter_head") or frappe.db.get_value(
		"Letter Head", {"disabled": 0, "is_default": 1}, "name"
	)
	return {
		"formats": formats,
		"default_format": default_format if default_format in formats else "Standard",
		"letter_heads": letter_heads,
		"default_letter_head": default_letter_head if default_letter_head in letter_heads else "",
	}
