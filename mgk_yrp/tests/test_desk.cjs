const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const doctypes = resolve(__dirname, "../mgk_yrp/doctype");

function desk(permissions = {}) {
	const events = {};
	const frappe = {
		listview_settings: {},
		get_meta: () => ({ states: [] }),
		workflow: {
			workflows: {}, avoid_status_override: {}, get_state_fieldname: () => null,
		},
		model: {
			is_submittable: () => true,
			can_create: doctype => permissions[doctype] !== false,
			can_read: doctype => permissions[doctype] !== false,
			can_cancel: () => permissions.cancel !== false,
		},
		ui: { form: { on: (doctype, handlers) => { events[doctype] = handlers; } } },
	};
	const context = vm.createContext({ frappe, __: value => value, flt: value => Number(value) || 0 });
	vm.runInContext(readFileSync(resolve(__dirname,
		"../../../frappe/frappe/public/js/frappe/model/indicator.js"), "utf8"), context);
	return { frappe, events, context };
}

function load(environment, doctype, suffix = "") {
	const name = doctype.toLowerCase().replaceAll(" ", "_");
	vm.runInContext(readFileSync(resolve(doctypes, name, `${name}${suffix}.js`), "utf8"),
		environment.context);
}

const indicators = [
	["MGK Purchase Order", { docstatus: 0, status: "Draft" }, "Draft", "red"],
	["MGK Purchase Order", { status: "To Receive" }, "To Receive", "orange"],
	["MGK Purchase Order", { status: "Partially Received" }, "Partially Received", "yellow"],
	["MGK Purchase Order", { status: "Completed" }, "Completed", "green"],
	["MGK Purchase Order", { docstatus: 2, status: "Cancelled" }, "Cancelled", "grey"],
	["MGK Delivery Challan", { close_status: "Open" }, "Open", "blue"],
	["MGK Delivery Challan", { close_status: "Closed" }, "Closed", "green"],
	["MGK Delivery Challan", { close_status: "Reopening" }, "Reopening", "orange"],
	["MGK Delivery Challan", { is_return: 1 }, "Return", "grey"],
	["MGK Delivery Challan", { docstatus: 0, is_return: 1 }, "Draft", "red"],
	["MGK Delivery Challan", { docstatus: 2, close_status: "Closed" }, "Cancelled", "red"],
	["MGK Goods Received Note", {}, "To Bill", "orange"],
	["MGK Goods Received Note", { purchase_invoice: "PI", purchase_invoice_docstatus: 0 }, "To Bill", "orange"],
	["MGK Goods Received Note", { purchase_invoice: "PI", purchase_invoice_docstatus: 1 }, "Billed", "green"],
	["MGK Goods Received Note", { purchase_invoice: "PI", purchase_invoice_docstatus: 2 }, "To Bill", "orange"],
	["MGK Goods Received Note", { purchase_invoice: "PI" }, "Invoice Linked", "orange"],
	["MGK Goods Received Note", { docstatus: 0 }, "Draft", "red"],
	["MGK Goods Received Note", { docstatus: 2 }, "Cancelled", "red"],
	["MGK Delivery Challan Close", { docstatus: 2, reopen_status: "Reversing" }, "Reversing", "orange"],
	["MGK Delivery Challan Close", { docstatus: 2, reopen_status: "Reopened" }, "Reopened", "grey"],
	["MGK Delivery Challan Close", { docstatus: 2 }, "Cancelled", "red"],
	["MGK Delivery Challan Close", { docstatus: 0 }, "Draft", "red"],
	["MGK Delivery Challan Close", {}, "Submitted", "blue"],
	["MGK Purchase Invoice", {}, "Submitted", "green"],
	["MGK Purchase Invoice", { docstatus: 0 }, "Draft", "red"],
	["MGK Purchase Invoice", { docstatus: 2 }, "Cancelled", "red"],
];

for (const [doctype, values, label, color] of indicators) {
	test(`${doctype}: ${JSON.stringify(values)} shows ${label}`, () => {
		const environment = desk();
		load(environment, doctype, "_list");
		const indicator = environment.frappe.get_indicator({ doctype, docstatus: 1, ...values });
		assert.deepEqual(Array.from(indicator).slice(0, 2), [label, color]);
		assert.ok(indicator[2], "indicator includes a list filter");
	});
}

test("GRN list reads current linked invoice status in its list query", () => {
	const environment = desk();
	load(environment, "MGK Goods Received Note", "_list");
	const listview = { fields: ["name"], get_fields() { return this.fields; } };
	environment.frappe.listview_settings["MGK Goods Received Note"].onload(listview);
	assert.deepEqual(Array.from(listview.get_fields()),
		["name", "purchase_invoice.docstatus as purchase_invoice_docstatus"]);
	assert.deepEqual(listview.fields, ["name"]);
});

test("GRN list remains accessible without invoice read permission", () => {
	const environment = desk({ "MGK Purchase Invoice": false });
	load(environment, "MGK Goods Received Note", "_list");
	const listview = { get_fields: () => ["name"] };
	environment.frappe.listview_settings["MGK Goods Received Note"].onload(listview);
	assert.deepEqual(listview.get_fields(), ["name"]);
});

test("GRN badge filters use the receipt's invoice link supported by Desk", () => {
	const environment = desk();
	load(environment, "MGK Goods Received Note", "_list");
	const settings = environment.frappe.listview_settings["MGK Goods Received Note"];
	assert.equal(settings.get_indicator({ purchase_invoice: "PI", purchase_invoice_docstatus: 1 })[2],
		"purchase_invoice,=,PI");
	assert.equal(settings.get_indicator({})[2], "purchase_invoice,is,not set");
});

function buttons(doctype, doc, permissions) {
	const environment = desk(permissions);
	load(environment, doctype);
	const shown = [];
	const grid = { update_docfield_property() {}, refresh() {} };
	const form = {
		doctype, doc, fields_dict: { items: { grid } },
		add_custom_button: label => shown.push(label), set_intro() {},
	};
	environment.events[doctype].refresh(form);
	return shown;
}

for (const docstatus of [0, 1, 2]) {
	for (const pending_qty of [0, 10]) {
		test(`PO Create GRN visibility: status ${docstatus}, pending ${pending_qty}`, () => {
			assert.deepEqual(buttons("MGK Purchase Order", { docstatus, items: [{ pending_qty }] }),
				docstatus === 1 && pending_qty > 0 ? ["Create GRN"] : []);
		});
	}
}

test("PO Create GRN respects create permission", () => {
	assert.deepEqual(buttons("MGK Purchase Order", { docstatus: 1, items: [{ pending_qty: 10 }] },
		{ "MGK Goods Received Note": false }), []);
});

for (const docstatus of [0, 1, 2]) {
	for (const close_status of ["Open", "Closed", "Reopening"]) {
		for (const is_return of [0, 1]) {
			test(`DC action visibility: status ${docstatus}, ${close_status}, return ${is_return}`, () => {
				assert.deepEqual(buttons("MGK Delivery Challan", { docstatus, close_status, is_return }),
					docstatus === 1 && close_status === "Open" && !is_return ? ["Return", "Close"] : []);
			});
		}
	}
}

test("DC Return and Close respect their create permissions separately", () => {
	const doc = { docstatus: 1, close_status: "Open" };
	assert.deepEqual(buttons("MGK Delivery Challan", doc, { "MGK Delivery Challan": false }), ["Close"]);
	assert.deepEqual(buttons("MGK Delivery Challan", doc, { "MGK Delivery Challan Close": false }), ["Return"]);
});

for (const [docstatus, reopen_status, expected] of [
	[0, "", []], [1, "", ["Reopen"]], [2, "Reversing", ["Finish Reopen"]], [2, "Reopened", []],
]) {
	test(`Close action visibility: status ${docstatus}, ${reopen_status}`, () => {
		assert.deepEqual(buttons("MGK Delivery Challan Close", { docstatus, reopen_status }), expected);
	});
}

test("Close reopening actions require cancel permission", () => {
	assert.deepEqual(buttons("MGK Delivery Challan Close", { docstatus: 1 }, { cancel: false }), []);
	assert.deepEqual(buttons("MGK Delivery Challan Close",
		{ docstatus: 2, reopen_status: "Reversing" }, { cancel: false }), []);
});
