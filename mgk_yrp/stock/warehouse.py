from yrp.yrp.doctype.yrp_delivery_challan.yrp_delivery_challan import _get_warehouse_for_supplier


def get_supplier_warehouse(supplier: str | None) -> str | None:
	return _get_warehouse_for_supplier(supplier)
