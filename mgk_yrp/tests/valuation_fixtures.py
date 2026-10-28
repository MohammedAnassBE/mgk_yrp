from collections import defaultdict
from contextlib import contextmanager
from unittest.mock import patch

import frappe
from frappe.model.base_document import BaseDocument
from yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment import yrp_stock_valuation_adjustment as valuation


@contextmanager
def valuation_checkpoints():
	"""Keep worker checkpoints inside the test's rollback transaction."""
	checkpoint = f"valuation_{frappe.generate_hash(length=10)}"
	rollback = frappe.db.rollback

	def commit():
		frappe.db.savepoint(checkpoint)

	def rollback_checkpoint(*, save_point=None, chain=False):
		rollback(save_point=save_point or checkpoint)

	commit()
	with (
		patch.object(frappe.db, "commit", side_effect=commit),
		patch.object(frappe.db, "rollback", side_effect=rollback_checkpoint),
		patch.object(valuation, "enqueue_adjustment"),
	):
		yield


def process_adjustment(name):
	with valuation_checkpoints():
		return valuation.process_adjustment(name)


@contextmanager
def committed_stock_records():
	"""Remove records inserted by a test that deliberately commits across connections."""
	records = defaultdict(set)
	insert = BaseDocument.db_insert

	def record_insert(doc, *args, **kwargs):
		result = insert(doc, *args, **kwargs)
		records[doc.doctype].add(doc.name)
		return result

	with patch.object(BaseDocument, "db_insert", record_insert):
		try:
			yield
		finally:
			frappe.db.rollback()
			for doctype, names in reversed(records.items()):
				frappe.db.delete(doctype, {"name": ["in", sorted(names)]})
			frappe.db.commit()
