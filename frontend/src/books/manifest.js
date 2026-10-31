import purchaseOrder from "./purchase-order/config.js"
import billing from "./billing/config.js"
import deliveryChallan from "./delivery-challan/config.js"
import deliveryChallanClose from "./delivery-challan-close/config.js"
import goodsReceivedNote from "./goods-received-note/config.js"
import stock from "./stock/config.js"
import masters from "./masters/config.js"
import supplierCreditDebit from "./supplier-credit-debit/config.js"
import paymentLedger from "./payment-ledger/config.js"
import pendingBills from "./pending-bills/config.js"

export const bookManifest = [purchaseOrder, billing, pendingBills, deliveryChallan, deliveryChallanClose, goodsReceivedNote, stock, masters, supplierCreditDebit, paymentLedger]
export const manifestByType = Object.fromEntries(bookManifest.map((book) => [book.type, book]))
export const homeManifestByType = Object.fromEntries(bookManifest.filter((book) => book.showOnHome !== false).map((book) => [book.type, book]))
