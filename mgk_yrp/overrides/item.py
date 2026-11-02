from mgk_yrp.stock.attribute_defaults import validate_default_values
from mgk_yrp.stock.process_conversion import validate_process_conversions


def validate(doc, method=None):
	validate_process_conversions(doc)
	validate_default_values(doc)
