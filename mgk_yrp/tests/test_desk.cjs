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
	const context = vm.createContext({ frappe,
		__: (value, args = []) => value.replace(/\{(\d+)\}/g, (_, index) => args[index]),
		flt: value => Number(value) || 0, format_currency: value => `₹${Number(value).toFixed(2)}`,
	});
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

function refreshForm(doctype, doc, permissions) {
	const environment = desk(permissions);
	load(environment, doctype);
	const shown = [];
	const grid = { update_docfield_property() {}, refresh() {} };
	const form = {
		doctype, doc, fields_dict: { items: { grid } },
		add_custom_button: label => shown.push(label), remove_custom_button() {}, set_intro() {},
		set_df_property() {}, page: { clear_secondary_action() {} },
	};
	environment.events[doctype].refresh(form);
	return { environment, form, shown };
}

function buttons(doctype, doc, permissions) {
	return refreshForm(doctype, doc, permissions).shown;
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

for (const [doctype, linked] of [
	["MGK Purchase Invoice", ["MGK Goods Received Note", "YRP Stock Valuation Adjustment"]],
	["MGK Goods Received Note", ["MGK Purchase Invoice", "MGK Delivery Challan Close",
		"YRP Stock Ledger Entry", "YRP Repost Item Valuation", "YRP Stock Valuation Adjustment",
		"YRP Stock Valuation Production Link"]],
	["MGK Delivery Challan", ["MGK Delivery Challan", "MGK Goods Received Note",
		"MGK Delivery Challan Close", "YRP Stock Ledger Entry", "YRP Repost Item Valuation",
		"YRP Stock Valuation Adjustment", "YRP Stock Valuation Production Link"]],
	["MGK Purchase Order", ["MGK Goods Received Note"]],
]) {
	test(`${doctype}: form Cancel reaches server guards without Cancel All`, async () => {
		const { environment, form } = refreshForm(doctype, { doctype, name: "test", docstatus: 1 });
		for (const name of linked) assert.ok(form.ignore_doctypes_on_cancel_all.includes(name), name);
		let cancelled = false;
		form.validate_form_action = action => assert.equal(action, "Cancel");
		form._cancel = () => { cancelled = true; };
		form._cancel_all = () => assert.fail("must reach the MGK server guard");
		environment.context.cstr = String;
		environment.frappe.call = async ({ args }) => ({ message: { docs: linked
			.filter(name => !args.ignore_doctypes_on_cancel_all.includes(name))
			.map(name => ({ doctype: name })) } });
		const source = readFileSync(resolve(__dirname,
			"../../../frappe/frappe/public/js/frappe/form/form.js"), "utf8");
		const start = source.indexOf("\tsavecancel(btn,");
		const end = source.indexOf("\n\t_cancel_all(", start);
		const methods = vm.runInContext(`({${source.slice(start, end)}})`, environment.context);
		methods.savecancel.call(form);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(cancelled, true);
	});
}

test("Close has one Reopen action with reopen confirmation", () => {
	const { environment, form, shown } = refreshForm("MGK Delivery Challan Close", { docstatus: 0 });
	let cleared = 0;
	let reopen;
	let saved = 0;
	form.doc = { docstatus: 1, delivery_challan: "MGK-DC-test" };
	form.page.clear_secondary_action = () => { cleared++; };
	form.validate_form_action = action => assert.equal(action, "Cancel");
	form.add_custom_button = (label, callback) => { shown.push(label); reopen = callback; };
	form._cancel = (...args) => { assert.equal(args[3], true); saved++; };
	form.savecancel = () => assert.fail("generic permanent-cancel confirmation");
	let confirm;
	environment.frappe.confirm = (message, callback) => {
		assert.match(message, /Reopen Delivery Challan MGK-DC-test/);
		assert.doesNotMatch(message, /Permanently Cancel/);
		confirm = callback;
	};
	environment.events[form.doctype].refresh(form);
	assert.equal(cleared, 1);
	assert.deepEqual(shown, ["Reopen"]);
	reopen();
	assert.equal(saved, 0);
	confirm();
	assert.equal(saved, 1);
});

test("Close intro uses currency precision for repeating rates", () => {
	const { environment, form } = refreshForm("MGK Delivery Challan Close", { docstatus: 0 });
	form.doc = { docstatus: 0, outputs: [{}], output_stock_uom: "Kg", value_per_unit: 2500 / 60 };
	let intro;
	form.set_intro = message => { intro = message; };
	environment.events[form.doctype].refresh(form);
	assert.equal(intro, "Adds ₹41.67 per Kg to 1 GRN rows");
});

for (const name of ["mgk_delivery_challan_close", "mgk_delivery_challan_close_item",
	"mgk_delivery_challan_close_output"]) {
	test(`${name}: readable labels, currency defaults and visible grid columns`, () => {
		const meta = JSON.parse(readFileSync(resolve(doctypes, name, `${name}.json`), "utf8"));
		for (const field of meta.fields) {
			assert.doesNotMatch(field.label, /\b(Dc|Uom|Sle)\b/);
			if (field.fieldtype === "Currency") assert.equal(field.precision, undefined);
		}
		if (meta.istable) {
			assert.ok(meta.fields.some(field => field.fieldname === "item" && field.in_list_view));
			assert.equal(meta.fields.reduce((sum, field) => sum + (field.columns || 0), 0), 10);
		}
	});
}
