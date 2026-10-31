from mgk_yrp.stock.process_conversion import validate_process_conversions


def validate(doc, method=None):
	validate_process_conversions(doc)
