import purchaseOrder from "./purchase-order/index.js"
import billing from "./billing/index.js"
import deliveryChallan from "./delivery-challan/index.js"
import deliveryChallanClose from "./delivery-challan-close/index.js"
import goodsReceivedNote from "./goods-received-note/index.js"
import stock from "./stock/index.js"
import masters from "./masters/index.js"
import supplierCreditDebit from "./supplier-credit-debit/index.js"
import paymentLedger from "./payment-ledger/index.js"
import pendingBills from "./pending-bills/index.js"

export const books = [purchaseOrder, billing, pendingBills, deliveryChallan, deliveryChallanClose, goodsReceivedNote, stock, masters, supplierCreditDebit, paymentLedger]
export const bookRegistry = Object.fromEntries(books.map((book) => [book.type, book]))
