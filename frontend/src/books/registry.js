import purchaseOrder from "./purchase-order/index.js"
import billing from "./billing/index.js"
import deliveryChallan from "./delivery-challan/index.js"
import goodsReceivedNote from "./goods-received-note/index.js"
import stock from "./stock/index.js"
import masters from "./masters/index.js"

export const books = [purchaseOrder, billing, deliveryChallan, goodsReceivedNote, stock, masters]
export const bookRegistry = Object.fromEntries(books.map((book) => [book.type, book]))
