import purchaseOrderLayout from "./purchase-order/layout.js"
import grnLayout from "./goods-received-note/layout.js"
import { createFieldEvents as purchaseOrderEvents } from "./purchase-order/fieldEvents.js"
import { createFieldEvents as grnEvents, fieldOverrides, initialAutoFields } from "./goods-received-note/fieldEvents.js"
import { actions } from "./purchase-order/actions.js"
import * as purchaseOrderPresentation from "./purchase-order/presentation.js"
import * as grnPresentation from "./goods-received-note/presentation.js"
import dcLayout from "./delivery-challan/layout.js"
import { createFieldEvents as dcEvents } from "./delivery-challan/fieldEvents.js"
import { actions as dcActions } from "./delivery-challan/actions.js"
import * as dcPresentation from "./delivery-challan/presentation.js"
import closeLayout from "./delivery-challan-close/documentLayout.js"
import { createFieldEvents as closeEvents } from "./delivery-challan-close/fieldEvents.js"
import { actions as closeActions, finishReopen } from "./delivery-challan-close/actions.js"
import * as closePresentation from "./delivery-challan-close/presentation.js"
import invoiceLayout from "./purchase-invoice/layout.js"
import { createFieldEvents as invoiceEvents } from "./purchase-invoice/fieldEvents.js"
import * as invoicePresentation from "./purchase-invoice/presentation.js"

const modules = {
	"MGK Purchase Order": { layout: purchaseOrderLayout, createFieldEvents: purchaseOrderEvents,
		asyncFields: ["supplier_address", "contact_person"], actions, ...purchaseOrderPresentation },
	"MGK Goods Received Note": { layout: grnLayout, createFieldEvents: grnEvents,
		asyncFields: ["purchase_order"], fieldOverrides, initialAutoFields, ...grnPresentation },
	"MGK Delivery Challan": { layout: dcLayout, createFieldEvents: dcEvents, asyncFields: [], actions: dcActions, ...dcPresentation },
	"MGK Delivery Challan Close": { layout: closeLayout, createFieldEvents: closeEvents, asyncFields: ["delivery_challan"],
		actions: closeActions, finishReopen, ...closePresentation },
	"MGK Purchase Invoice": { layout: invoiceLayout, createFieldEvents: invoiceEvents, asyncFields: [], ...invoicePresentation },
}

export function documentModule(doctype) { return modules[doctype] || {} }
