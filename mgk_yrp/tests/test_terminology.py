from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from mgk_yrp.print_helpers import get_print_labels
from mgk_yrp.terminology import terms
from mgk_yrp.terminology.terms import TERMINOLOGY, get_default_terms, seed_terms, term_key, translate
from mgk_yrp.tests.fixtures import make_item, make_purchase_order, make_supplier, make_uom, make_warehouse
from mgk_yrp.web.boot import get_boot

TAMIL_PO = "MGK Purchase Order (Tamil)"
STATUS_OPEN = "mgk.status_open"


def term_rows():
	return {row.term_key: row for row in frappe.get_doc("YRP UI Terminology", TERMINOLOGY).terms}


def set_tamil(english, tamil):
	doc = frappe.get_doc("YRP UI Terminology", TERMINOLOGY)
	row = next(row for row in doc.terms if row.term_key == term_key(english))
	row.tamil_text = tamil
	doc.save(ignore_permissions=True)


class TestTerminology(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.addCleanup(frappe.db.rollback)
		self.addCleanup(frappe.cache.delete_value, terms.CACHE_KEY)
		self.addCleanup(frappe.set_user, frappe.session.user)
		frappe.set_user("Administrator")
		seed_terms()

	def test_defaults_cover_print_and_web_words_with_unique_keys(self):
		defaults = get_default_terms()
		for english in (
			"Purchase Order",
			"Goods Received Note",
			"Karigan",
			"Salavai Cone",
			"All",
			"Save",
			"Print",
		):
			self.assertIn(english, defaults)
		self.assertEqual(defaults["Karigan"], "காரிகான்")
		self.assertEqual(defaults["Salavai Cone"], "சலவைக்கோன்")
		self.assertEqual(defaults["All"], "அனைத்தும்")
		keys = [term_key(english) for english in defaults]
		self.assertEqual(len(keys), len(set(keys)), "two defaults derive the same term key")
		self.assertTrue(all(tamil.strip() for tamil in defaults.values()))
		too_long = [english for english, tamil in defaults.items() if max(len(english), len(tamil)) > 140]
		self.assertEqual(too_long, [], "YRP UI Term texts are Data fields capped at 140 characters")

	def test_seeding_adds_every_default_once(self):
		rows = term_rows()
		self.assertTrue({term_key(english) for english in get_default_terms()} <= set(rows))
		count = len(rows)
		seed_terms()
		self.assertEqual(len(term_rows()), count)
		self.assertEqual(rows[term_key("Purchase Order")].tamil_text, "கொள்முதல் ஆணை")

	def test_seeding_preserves_user_edits_and_restores_only_missing_rows(self):
		set_tamil("Purchase Order", "வாங்கும் ஆணை")
		doc = frappe.get_doc("YRP UI Terminology", TERMINOLOGY)
		doc.terms = [row for row in doc.terms if row.term_key != term_key("Supplier")]
		doc.save(ignore_permissions=True)
		seed_terms()
		rows = term_rows()
		self.assertEqual(rows[term_key("Purchase Order")].tamil_text, "வாங்கும் ஆணை")
		self.assertEqual(rows[term_key("Supplier")].tamil_text, get_default_terms()["Supplier"])

	def test_edit_invalidates_cache_and_notifies_clients(self):
		self.assertEqual(translate("Purchase Order"), "கொள்முதல் ஆணை")
		with patch("frappe.publish_realtime") as publish:
			set_tamil("Purchase Order", "வாங்கும் ஆணை")
		publish.assert_any_call(terms.REALTIME_EVENT, {}, after_commit=True)
		self.assertEqual(translate("Purchase Order"), "வாங்கும் ஆணை")
		self.assertEqual(translate("PURCHASE ORDER"), "வாங்கும் ஆணை", "lookup ignores case")
		self.assertEqual(translate("Purchase Order", tamil=0), "Purchase Order")
		self.assertEqual(translate("No Such Words"), "No Such Words")

	def test_print_labels_fall_back_to_english(self):
		self.assertEqual(get_print_labels(1)["DRAFT"], "வரைவு")
		self.assertEqual(get_print_labels(1)["Unknown Label"], "Unknown Label")
		self.assertEqual(get_print_labels(0)["DRAFT"], "DRAFT")

	def test_tamil_print_uses_the_edited_term(self):
		set_tamil("Purchase Order", "வாங்கும் ஆணை")
		order = make_purchase_order(
			supplier=make_supplier(),
			warehouse=make_warehouse(supplier=make_supplier(is_company_location=1)),
			items=[{"item": make_item(stock_uom=make_uom("Kg")), "qty": 1, "rate": 10}],
		)
		html = frappe.get_print(order.doctype, order.name, print_format=TAMIL_PO)
		self.assertIn("வாங்கும் ஆணை", html)
		self.assertNotIn("கொள்முதல் ஆணை", html)

	def test_boot_delivers_terms_by_key(self):
		set_tamil("Save", "பதிவு செய்")
		self.assertEqual(get_boot()["terms"][term_key("Save")], {"source": "Save", "ta": "பதிவு செய்"})

	def test_open_status_has_its_own_term_and_the_open_button_keeps_its_word(self):
		row = term_rows()[STATUS_OPEN]
		self.assertEqual((row.source_text, row.tamil_text), ("Open", "திறந்தவை"))
		self.assertEqual(translate("Open"), "திற")
		self.assertEqual(get_boot()["terms"][STATUS_OPEN], {"source": "Open", "ta": "திறந்தவை", "keyed": 1})
		self.assertEqual(get_boot()["terms"][term_key("Open")], {"source": "Open", "ta": "திற"})

	def test_seeding_keeps_an_edited_status_term_and_restores_a_removed_one(self):
		doc = frappe.get_doc("YRP UI Terminology", TERMINOLOGY)
		next(row for row in doc.terms if row.term_key == STATUS_OPEN).tamil_text = "திறந்த நிலை"
		doc.save(ignore_permissions=True)
		seed_terms()
		self.assertEqual(term_rows()[STATUS_OPEN].tamil_text, "திறந்த நிலை")
		doc = frappe.get_doc("YRP UI Terminology", TERMINOLOGY)
		doc.terms = [row for row in doc.terms if row.term_key != STATUS_OPEN]
		doc.save(ignore_permissions=True)
		seed_terms()
		self.assertEqual(term_rows()[STATUS_OPEN].tamil_text, "திறந்தவை")
