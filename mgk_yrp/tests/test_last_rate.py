from unittest.mock import patch

from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, nowdate

from mgk_yrp.purchase import last_rate
from mgk_yrp.tests.fixtures import make_item, make_purchase_order, make_supplier, make_uom, make_warehouse


class TestLastPurchaseRate(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.supplier = make_supplier()
		self.warehouse = make_warehouse(supplier=make_supplier(is_company_location=1))
		self.item = make_item(stock_uom=make_uom("Kg"))

	def order(self, rate, supplier=None, submit=True, po_date=None):
		return make_purchase_order(
			supplier=supplier or self.supplier,
			warehouse=self.warehouse,
			items=[{"item": self.item, "qty": 2, "rate": rate}],
			submit=submit,
			po_date=po_date or nowdate(),
		)

	def rates(self, supplier=None, current=None):
		details = [{"primary_attribute": "", "items": [{"name": self.item, "attributes": {}, "values": {"default": {"qty": 0}}}]}]
		return last_rate.get_last_purchase_rates(details, supplier=supplier or self.supplier, current_purchase_order=current)

	def test_latest_submitted_order_of_the_same_supplier_wins(self):
		self.order(90, po_date=add_days(nowdate(), -2))
		newer = self.order(110, po_date=add_days(nowdate(), -1))
		self.order(150, submit=False)
		self.order(170, supplier=make_supplier())

		result = self.rates()["0:0:default"]

		self.assertEqual(result["rate"], 110)
		self.assertEqual(result["purchase_order"], newer.name)
		self.assertEqual(str(result["po_date"]), add_days(nowdate(), -1))

	def test_current_order_is_excluded_and_no_history_returns_nothing(self):
		only = self.order(110)

		self.assertEqual(self.rates(current=only.name), {})
		self.assertEqual(self.rates(supplier=make_supplier()), {})

	def test_resolves_variant_per_primary_attribute_value(self):
		details = [{"primary_attribute": "Size", "items": [{"name": "Yarn", "attributes": {"Colour": "Blue", "Shade": ""},
			"values": {"S": {"qty": 5}, "M": None}}]}]

		with patch("yrp.yrp.doctype.yrp_item.yrp_item.get_variant", return_value="Yarn-Blue-S") as get_variant:
			result = last_rate.resolve_last_rate_variants(details)

		self.assertEqual(result, {"0:0:S": "Yarn-Blue-S"})
		get_variant.assert_called_once_with("Yarn", {"Colour": "Blue", "Size": "S"})

	def test_only_positive_rates_count(self):
		orders = [type("Order", (), {"name": "PO-NEW", "po_date": "2026-10-02"}), type("Order", (), {"name": "PO-OLD", "po_date": "2026-10-01"})]
		rows = [
			{"parent": "PO-OLD", "item": "Yarn-Blue", "rate": 90, "idx": 1},
			{"parent": "PO-NEW", "item": "Yarn-Blue", "rate": 110, "idx": 1},
		]
		with patch.object(last_rate.frappe, "get_all", return_value=[type("Row", (), row) for row in rows]) as get_all:
			result = last_rate.get_latest_rates(orders, {"Yarn-Blue"})

		self.assertEqual(result["Yarn-Blue"], {"rate": 110, "purchase_order": "PO-NEW", "po_date": "2026-10-02"})
		self.assertEqual(get_all.call_args.kwargs["filters"]["rate"], [">", 0])
