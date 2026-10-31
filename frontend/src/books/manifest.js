import purchaseOrder from "./purchase-order/config.js"
import billing from "./billing/config.js"
import deliveryChallan from "./delivery-challan/config.js"
import deliveryChallanClose from "./delivery-challan-close/config.js"
import goodsReceivedNote from "./goods-received-note/config.js"
import stock from "./stock/config.js"
import masters from "./masters/config.js"

export const bookManifest = [purchaseOrder, billing, deliveryChallan, deliveryChallanClose, goodsReceivedNote, stock, masters]
export const manifestByType = Object.fromEntries(bookManifest.map((book) => [book.type, book]))
