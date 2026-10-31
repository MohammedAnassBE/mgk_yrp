const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const doctypes = resolve(__dirname, "../mgk_yrp/doctype");
const editorDirectory = resolve(__dirname, "../public/js");
const editorDoctypes = ["MGK Purchase Order", "MGK Delivery Challan", "MGK Goods Received Note"];

function dialogHarness(environment) {
	const dialogs = [];
	environment.frappe.ui.Dialog = class {
		constructor(options) {
			Object.assign(this, options);
			this.fields_dict = { item_html: { wrapper: {} } };
			dialogs.push(this);
		}
		show() { this.visible = true; this.on_page_show?.(); }
		hide() { this.visible = false; this.onhide?.(); }
		get_primary_btn() { return { prop() {} }; }
	};
	return dialogs;
}

function attributeGrid(environment, items) {
	const source = readFileSync(resolve(editorDirectory, 'AttributeColumns.vue'), 'utf8')
		.split('<script setup>')[1].split('</script>')[0].replace(/^import .*;$/gm, '');
	const watches = [], events = [];
	const context = vm.createContext({ ...environment.context,
		defineProps: () => ({ items, edit: true, mode: 'grn_job' }),
		defineEmits: () => (...args) => events.push(args), ref: value => ({ value }),
		watch: (getter, callback) => watches.push({ getter, callback }),
		onMounted: callback => { environment.gridMounted = callback; },
	});
	vm.runInContext(source, context);
	return { context, watches, events };
}

function vueEditor(environment, props) {
	const component = readFileSync(resolve(editorDirectory, "ItemEditor.vue"), "utf8");
	const source = component.split('<script setup>')[1].split('</script>')[0].replace(/^import .*;$/gm, "");
	let exposed;
	const context = vm.createContext({ ...environment.context,
		defineProps: () => props, ref: value => ({ value }),
		onMounted: callback => { environment.mounted = callback; }, onBeforeUnmount() {},
		nextTick: () => Promise.resolve(), WeakSet,
		MutationObserver: class { constructor(callback) { environment.mutate = callback; } observe() {} disconnect() {} },
		computed: getter => ({ get value() { return getter(); } }),
		defineExpose: value => { exposed = value; },
	});
	vm.runInContext(source, context);
	return { exposed, context, emit: event => {
		const handler = component.match(new RegExp(`@${event}="(\\w+)"`))[1];
		return vm.runInContext(`${handler}()`, context);
	} };
}

function loadEditor(environment) {
	const { frappe, context } = environment;
	frappe.provide = path => path.split('.').slice(1).reduce((parent, key) =>
		(parent[key] ||= {}), frappe);
	vm.runInContext(readFileSync(resolve(editorDirectory, "item_editor.js"), "utf8"), context);
	vm.runInContext(readFileSync(resolve(editorDirectory, "transit.js"), "utf8"), context);
	vm.runInContext(readFileSync(resolve(editorDirectory, "job_work.js"), "utf8"), context);
	context.SetVueGlobals = app => { app.globalsSet = true; };
	context.createApp = (component, props) => ({
		unmounted: false,
		unmount() { this.unmounted = true; },
		mount() {
			assert.equal(this.globalsSet, true);
			const editor = vueEditor(environment, props);
			this.context = editor.context;
			return editor.exposed;
		},
	});
	context.ItemEditor = {};
	vm.runInContext(readFileSync(resolve(editorDirectory, "mgk_yrp.bundle.js"), "utf8")
		.replace(/^import .*;$/gm, ""), context);
}

function desk(permissions = {}) {
	const events = {};
	const frappe = {
		utils: { escape_html: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') },
		listview_settings: {},
		throw(message) { throw new Error(message); },
		get_meta: () => ({ states: [] }),
		workflow: {
			workflows: {}, avoid_status_override: {}, get_state_fieldname: () => null,
		},
		model: {
			is_submittable: () => true,
			can_create: doctype => permissions[doctype] !== false,
			can_write: doctype => permissions[doctype] !== false && permissions[`write:${doctype}`] !== false,
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
	const environment = { frappe, events, context };
	loadEditor(environment);
	return environment;
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

function refreshForm(doctype, doc, permissions, refresh = true) {
	const environment = desk(permissions);
	load(environment, doctype);
	const shown = [];
	const grid = { update_docfield_property() {}, refresh() {} };
	const form = {
		doctype, doc: { doctype, ...doc }, fields_dict: { items: { grid }, outputs: { grid } },
		add_custom_button: label => shown.push(label), remove_custom_button() {},
		set_intro(message) { this.intro = message; },
		set_df_property() {}, page: { clear_secondary_action() {} },
		is_new() { return !this.doc.name; },
		async set_value(field, value) {
			Object.assign(this.doc, typeof field === 'string' ? { [field]: value } : field);
		},
		clear_table(field) { this.doc[field] = []; },
		refresh_field() {}, refresh_fields() {}, dirty() {},
	};
	if (editorDoctypes.includes(doctype)) form.fields_dict.item_html = { wrapper: {} };
	if (refresh) environment.events[doctype].refresh(form);
	return { environment, form, shown };
}

function copyDocument(environment, doc, amend) {
	const { frappe, context } = environment;
	context.$ = { extend: Object.assign };
	context.cint = Number;
	frappe.session = { user: 'test@example.com' };
	frappe.meta = { get_docfield(doctype, fieldname) {
		const name = doctype.toLowerCase().replaceAll(' ', '_');
		const meta = JSON.parse(readFileSync(resolve(doctypes, name, `${name}.json`)));
		return meta.fields.find(field => field.fieldname === fieldname);
	} };
	vm.runInContext(readFileSync(resolve(__dirname,
		'../../../frappe/frappe/public/js/frappe/model/create_new.js'), 'utf8'), context);
	frappe.model.table_fields = ['Table', 'Table MultiSelect'];
	let sequence = 0;
	frappe.model.get_new_doc = (doctype, parent, fieldname) => {
		const row = { doctype, name: `new-${++sequence}`, docstatus: 0, __islocal: 1 };
		if (parent) (parent[fieldname] ||= []).push(row);
		return row;
	};
	return frappe.model.copy_doc(doc, amend);
}

function buttons(doctype, doc, permissions) {
	return refreshForm(doctype, doc, permissions).shown;
}

test("MGK includes only its own bundle", () => {
	const hooks = readFileSync(resolve(__dirname, '../hooks.py'), 'utf8');
	assert.match(hooks, /^app_include_js = \["mgk_yrp.bundle.js"\]$/m);
});

for (const doctype of ["MGK Delivery Challan", "MGK Goods Received Note"]) {
	for (const [status, transferred, shown] of [["In Transit", 0, true], ["Partly Transferred", 6, true], ["Transferred", 10, false]]) {
		test(`${doctype}: T5 T10 T13 transfer ${status} button and indicator`, () => {
			const values = { name: 'source', docstatus: 1, is_internal_transfer: 1, transfer_status: status,
				close_status: 'Open', items: [{ qty: 10, transferred_qty: transferred }] };
			const result = refreshForm(doctype, values);
			assert.equal(result.shown.includes('Complete Transfer'), shown);
			assert.equal(result.shown.includes('Return'), doctype === 'MGK Delivery Challan' && shown);
			assert.ok(!result.shown.includes('Close'));
			assert.ok(result.form.ignore_doctypes_on_cancel_all.includes('YRP Stock Entry'));
			assert.ok(!buttons(doctype, values, { 'YRP Stock Entry': false }).includes('Complete Transfer'));
			assert.ok(!buttons(doctype, { ...values, docstatus: 0 }).includes('Complete Transfer'));
			assert.ok(!buttons(doctype, { ...values, docstatus: 2 }).includes('Complete Transfer'));
			assert.ok(!buttons(doctype, { ...values, is_internal_transfer: 0 }).includes('Complete Transfer'));
			load(result.environment, doctype, '_list');
			assert.equal(result.environment.frappe.get_indicator({ doctype, ...values })[0], status);
		});
	}

	test(`${doctype}: F3 intro lists pending quantities and clears after full completion`, () => {
		const { environment, form } = refreshForm(doctype, { name: 'source', docstatus: 1,
			is_internal_transfer: 1, transfer_status: 'Partly Transferred',
			items: [{ item: 'IE2 Yarn 40s', qty: 10, transferred_qty: 6, uom: 'Kg' },
				{ item: 'IE2 Tee-S', qty: 3, transferred_qty: 1, uom: 'Nos' },
				{ item: 'Done', qty: 2, transferred_qty: 2, uom: 'Nos' }] });
		assert.equal(form.intro, 'Pending in transit: IE2 Yarn 40s 4 Kg, IE2 Tee-S 2 Nos');
		form.doc.items[0].item = '<Yarn>';
		environment.events[doctype].refresh(form);
		assert.match(form.intro, /&lt;Yarn&gt; 4 Kg/);
		for (const row of form.doc.items) row.transferred_qty = row.qty;
		form.doc.transfer_status = 'Transferred';
		environment.events[doctype].refresh(form);
		assert.equal(form.intro, '');
	});

	test(`${doctype}: T6 T13 dialog filters destination, skips zero and submits editable quantities`, async () => {
		const { environment, form } = refreshForm(doctype, { name: 'source', docstatus: 1,
			is_internal_transfer: 1, transfer_status: 'Partly Transferred', to_location: 'Destination',
			delivery_location: 'Destination', to_warehouse: 'Receiving', warehouse: 'Receiving', transit_warehouse: 'Transit',
			items: [{ name: 'row-1', item: 'Yarn', uom: 'Kg', qty: 10, transferred_qty: 6 },
				{ name: 'row-2', item: 'Cotton', uom: 'Kg', qty: 5, transferred_qty: 0 },
				{ name: 'done', item: 'Done', qty: 2, transferred_qty: 2 }] }, undefined, false);
		let click, options, visible, hidden, submitted, notice, reloads = 0;
		form.add_custom_button = (label, callback) => { if (label === 'Complete Transfer') click = callback; };
		environment.frappe.ui.Dialog = class {
			constructor(value) { options = value; }
			show() { visible = true; }
			hide() { hidden = true; }
		};
		form.reload_doc = async () => { reloads++; };
		environment.frappe.call = async args => { submitted = args; return { message: 'STE-1' }; };
		environment.frappe.utils.get_form_link = (type, name) => `${type}/${name}`;
		environment.frappe.msgprint = value => { notice = value; };
		environment.events[doctype].refresh(form);
		click();
		assert.equal(visible, true);
		const warehouse = options.fields[0], table = options.fields[1];
		assert.equal(warehouse.default, 'Receiving');
		assert.deepEqual(JSON.parse(JSON.stringify(warehouse.get_query().filters)),
			{ supplier: 'Destination', disabled: 0, is_group: 0, name: ['!=', 'Transit'] });
		assert.deepEqual(Array.from(table.data, row => row.qty), [4, 5]);
		assert.equal(table.fields.find(field => field.fieldname === 'qty').read_only, undefined);
		for (const quantity of [-1, 5]) {
			await assert.rejects(options.primary_action({ warehouse: 'Receiving', items: [
				{ source_row: 'row-1', qty: quantity, pending_qty: 4 }] }), /cannot exceed pending/);
		}
		await assert.rejects(options.primary_action({ warehouse: 'Receiving', items: [] }), /positive quantity/);
		await options.primary_action({ warehouse: 'Second Receiving', items: [
			{ source_row: 'row-1', qty: 2, pending_qty: 4 }, { source_row: 'row-2', qty: 0, pending_qty: 5 }] });
		assert.equal(submitted.method, 'mgk_yrp.stock.transit.complete_transfer');
		assert.equal(submitted.freeze, true);
		assert.deepEqual(JSON.parse(JSON.stringify(submitted.args)), {
			doctype, name: 'source', warehouse: 'Second Receiving', items: [{ name: 'row-1', qty: 2 }],
		});
		assert.equal(hidden, true);
		assert.equal(reloads, 1);
		assert.match(notice, /YRP Stock Entry\/STE-1/);
	});

	test(`${doctype}: T5 T16 transit metadata is readonly and not copied`, () => {
		const name = doctype.toLowerCase().replaceAll(' ', '_');
		const header = JSON.parse(readFileSync(resolve(doctypes, name, `${name}.json`)));
		const child = JSON.parse(readFileSync(resolve(doctypes, `${name}_item`, `${name}_item.json`)));
		for (const field of [
			...header.fields.filter(field => ['is_internal_transfer', 'transit_warehouse', 'transfer_status'].includes(field.fieldname)),
			child.fields.find(field => field.fieldname === 'transferred_qty'),
		]) {
			assert.equal(field.read_only, 1);
			assert.equal(field.no_copy, 1);
			assert.ok(!field.allow_on_submit);
			assert.match(field.depends_on, /is_internal_transfer/);
		}
	});
}

test('U1 U4 DC actions use pending after returned stock is converted to row UOM', () => {
	for (const [returned, transferred, status, pending] of [
		[200, 0, 'Partly Transferred', 6], [200, 6, 'Transferred', 0], [500, 0, 'Returned', 0],
	]) {
		const doc = { name: 'DC', docstatus: 1, is_internal_transfer: 1, transfer_status: status,
			items: [{ item: 'Yarn', qty: 10, transferred_qty: transferred, returned_qty: returned,
				conversion_factor: 50, uom: 'Bag' }] };
		const { environment, form, shown } = refreshForm('MGK Delivery Challan', doc);
		assert.equal(shown.includes('Return'), pending > 0);
		assert.equal(shown.includes('Complete Transfer'), pending > 0);
		assert.equal(shown.includes('Close'), false);
		assert.equal(form.intro, pending ? 'Pending in transit: Yarn 6 Bag' : '');
		assert.equal(buttons('MGK Delivery Challan', doc, { 'MGK Delivery Challan': false }).includes('Return'), false);
		load(environment, 'MGK Delivery Challan', '_list');
		assert.equal(environment.frappe.get_indicator({ doctype: 'MGK Delivery Challan', ...doc })[0], status);
	}
});

test('U4 completion dialog defaults to pending after returns and skips fully returned rows', () => {
	const { environment, form } = refreshForm('MGK Delivery Challan', { docstatus: 1,
		is_internal_transfer: 1, items: [
			{ name: 'pending', item: 'Yarn', qty: 10, transferred_qty: 2, returned_qty: 200, conversion_factor: 50 },
			{ name: 'returned', item: 'Done', qty: 2, returned_qty: 100, conversion_factor: 50 },
		] }, undefined, false);
	let click, dialog;
	form.add_custom_button = (label, callback) => { if (label === 'Complete Transfer') click = callback; };
	environment.frappe.ui.Dialog = class {
		constructor(options) { dialog = options; }
		show() {}
	};
	environment.events[form.doctype].refresh(form);
	click();
	const rows = Array.from(dialog.fields[1].data, row => [row.source_row, row.pending_qty, row.qty]);
	assert.deepEqual(rows, [['pending', 4, 4]]);
});

test('C1 Desk Mark as Received uses current pending quantity after a manual half receipt', async () => {
	const { environment, form } = refreshForm('MGK Purchase Order', { name: 'PO', docstatus: 1,
		deliver_to_supplier: 1, delivery_location: 'Worker', process_name: 'Knitting',
		items: [{ qty: 100, received_qty: 50, pending_qty: 50 }] }, undefined, false);
	let click, confirm, sent;
	form.add_custom_button = (label, callback) => {
		if (label === 'Mark as Received') click = callback;
		return { prop() {} };
	};
	environment.frappe.confirm = (message, callback) => { confirm = callback; };
	environment.frappe.call = async request => {
		sent = request;
		return { message: { goods_received_note: 'GRN-50', delivery_challan: 'DC-50' } };
	};
	environment.frappe.utils.get_form_link = (type, name) => `${type}/${name}`;
	environment.frappe.msgprint = () => {};
	form.reload_doc = async () => {
		form.doc.status = 'Completed';
		form.doc.items[0].received_qty = 100;
		form.doc.items[0].pending_qty = 0;
	};
	environment.events[form.doctype].refresh(form);
	click();
	await confirm();
	assert.equal(sent.args.source_name, 'PO');
	assert.equal(Object.hasOwn(sent.args, 'qty'), false);
	assert.equal(form.doc.status, 'Completed');
	assert.ok(!buttons(form.doctype, form.doc).includes('Mark as Received'));
});

for (const doctype of editorDoctypes) {
	test(`${doctype}: editor and received type metadata`, () => {
		const name = doctype.toLowerCase().replaceAll(' ', '_');
		const meta = JSON.parse(readFileSync(resolve(doctypes, name, `${name}.json`)));
		assert.equal(meta.fields.find(field => field.fieldname === 'received_type'), undefined);
		assert.ok(!meta.field_order.includes('received_type'));
		assert.equal(meta.fields.find(field => field.fieldname === 'item_html').fieldtype, 'HTML');
		assert.equal(meta.fields.find(field => field.fieldname === 'item_details').hidden, 1);
		const child = JSON.parse(readFileSync(resolve(doctypes, `${name}_item`, `${name}_item.json`)));
		for (const [name, type] of [['row_index', 'Data'], ['table_index', 'Int']]) {
			const field = child.fields.find(field => field.fieldname === name);
			assert.equal(field.fieldtype, type);
			assert.equal(field.hidden, 1);
		}
	});

	test(`${doctype}: validate serialises editor items`, () => {
		const { environment, form } = refreshForm(doctype, { docstatus: 0 });
		const data = [{ items: [{ values: { default: { qty: 3, rate: 2, amount: 6 } } }] }];
		form.itemEditor.load_data(data);
		environment.events[doctype].validate(form);
		assert.deepEqual(JSON.parse(form.doc.item_details), data);
	});

	for (const name of [undefined, 'saved-draft']) {
		test(`${doctype}: validate clears blank and stale child rows on ${name || 'new draft'}`, () => {
			const { environment, form } = refreshForm(doctype, {
				name, docstatus: 0, item_details: '[]', items: [{}, { item: 'stale', qty: 5, rate: 0 }],
			});
			const data = [{ items: [{ values: { default: { qty: 3, rate: 0, amount: 0 } } }] }];
			form.itemEditor.load_data(data);
			environment.events[doctype].validate(form);
			assert.equal(form.doc.items.length, 0);
			assert.deepEqual(JSON.parse(form.doc.item_details), data);
		});
	}

	test(`${doctype}: empty editor gives a quantity message before child mandatory checks`, () => {
		const { environment, form } = refreshForm(doctype, { docstatus: 0, items: [{}] });
		for (const data of [[], [{ items: [] }]]) {
			form.itemEditor.load_data(data);
			assert.throws(() => environment.events[doctype].validate(form), /^Error: Enter Qty to continue$/);
		}
		assert.equal(form.doc.item_details, undefined);
	});

	test(`${doctype}: validate preserves child rows and payload without a draft editor`, () => {
		for (const state of ['unmounted', 1, 2]) {
			const { environment, form } = refreshForm(doctype, {
				docstatus: state === 'unmounted' ? 0 : state,
				items: [{ item: 'saved', qty: 5, rate: 2 }], item_details: '[{"items":[]}]',
			}, undefined, false);
			if (state !== 'unmounted') {
				environment.events[doctype].refresh(form);
				form.itemEditor.load_data([]);
			}
			const rows = form.doc.items;
			environment.events[doctype].validate(form);
			assert.equal(form.doc.items, rows);
			assert.equal(form.doc.item_details, '[{"items":[]}]');
		}
	});

}

test("editor mount skips missing HTML field or missing global", () => {
	for (const missing of ['html', 'global']) {
		const { environment, form } = refreshForm('MGK Purchase Order', { docstatus: 0 }, undefined, false);
		if (missing === 'html') delete form.fields_dict.item_html;
		else delete environment.frappe.mgk_yrp.ItemEditor;
		environment.events[form.doctype].refresh(form);
		assert.equal(form.itemEditor, undefined);
	}
});

test("editor forms refresh and validate without legacy child grids", () => {
	for (const doctype of editorDoctypes) {
		const { environment, form } = refreshForm(doctype, { docstatus: 0 }, undefined, false);
		delete form.fields_dict.items;
		environment.events[doctype].refresh(form);
		const data = [{ items: [{ values: { default: { qty: 3, rate: 2, amount: 6 } } }] }];
		form.itemEditor.load_data(data);
		environment.events[doctype].validate(form);
		assert.deepEqual(JSON.parse(form.doc.item_details), data);
		assert.equal(environment.events[`${doctype} Item`], undefined);
	}
});

test("GRN draft with mapped zero quantities still serialises and clears stale child rows", () => {
	const { environment, form } = refreshForm('MGK Goods Received Note', {
		docstatus: 0, against_purchase_order: 1, item_details: '[]', items: [{ item: 'mapped', qty: 0, rate: 2 }],
	});
	const data = [{ items: [{ values: { default: {
		qty: 0, rate: 2, amount: 0, purchase_order_item: 'PO-row',
	} } }] }];
	form.itemEditor.load_data(data);
	environment.events[form.doctype].validate(form);
	assert.equal(form.doc.items.length, 0);
	assert.deepEqual(JSON.parse(form.doc.item_details), data);
});

for (const [doctype, header, mode] of [
	['MGK Purchase Order', {}, 'po'],
	['MGK Delivery Challan', {}, 'dc'],
	['MGK Delivery Challan', { is_return: 1 }, 'dc_return'],
	['MGK Goods Received Note', { against_purchase_order: 1 }, 'grn_po'],
	['MGK Goods Received Note', {}, 'grn_job'],
]) {
	for (const operation of ['amend', 'duplicate']) {
		test(`${mode}: ${operation} hydrates copied rows without serialising local identities`, async () => {
			const { environment, form } = refreshForm(doctype, {}, undefined, false);
			const childtype = `${doctype} Item`;
			const source = { doctype, name: 'source', docstatus: operation === 'amend' ? 2 : 1, ...header,
				purchase_order: 'PO-1', return_against: 'DC-1',
				item_details: null, __onload: { item_details: [{ items: [] }] },
				items: ['S', 'M'].map((size, index) => {
					const qty = mode === 'grn_po' && index === 1 ? 0 : index + 2;
					const rate = mode === 'grn_job' ? 0 : 7;
					return { doctype: childtype, name: `old-${size}`, item: `Tee-${size}`, qty, rate,
						amount: qty * rate, row_index: '0', table_index: 0,
						purchase_order_item: `PO-${size}`, against_dc_item: `DC-${size}` };
				}),
			};
			form.doc = copyDocument(environment, source, operation === 'amend');
			assert.equal(form.doc.__onload, undefined);
			assert.ok(!form.doc.item_details);
			assert.equal(environment.frappe.mgk_yrp.item_editor_mode(form.doc), mode);
			if (mode === 'grn_po') assert.equal(form.doc.purchase_order, 'PO-1');
			if (mode === 'dc_return') assert.equal(form.doc.return_against, 'DC-1');
			assert.ok(form.doc.items.every(row => row.name.startsWith('new-')));
			let finish;
			const data = [{ primary_attribute: 'Size', items: [{ name: 'Tee', values:
				Object.fromEntries(form.doc.items.map((row, index) => [['S', 'M'][index], { ...row }])) }] }];
			let calls = 0;
			environment.frappe.call = ({ method, args }) => {
				assert.equal(method, 'mgk_yrp.stock.item_editor.get_draft_item_details');
				assert.deepEqual(JSON.parse(args.doc), JSON.parse(JSON.stringify(form.doc)));
				calls++;
				const pending = new Promise(resolve => { finish = resolve; });
				return { then: pending.then.bind(pending) };
			};
			const loading = environment.events[doctype].refresh(form);
			assert.equal(environment.events[doctype].refresh(form), loading);
			assert.throws(() => environment.events[doctype].validate(form), /Items are still loading/);
			finish({ message: data });
			await loading;
			assert.equal(calls, 1);
			const expected = JSON.parse(JSON.stringify(data));
			for (const cell of Object.values(expected[0].items[0].values)) delete cell.name;
			assert.deepEqual(JSON.parse(JSON.stringify(form.itemEditor.get_items())), expected);
			assert.equal(form.itemEditor.get_items()[0].items[0].name, 'Tee');
			assert.ok(form.doc.items.every(row => row.name.startsWith('new-')));
			assert.ok(Object.values(data[0].items[0].values).every(cell => cell.name.startsWith('new-')));
			environment.events[doctype].validate(form);
			assert.deepEqual(JSON.parse(form.doc.item_details), expected);
			assert.equal(form.doc.items.length, 0);
		});
	}

	test(`${mode}: local cell names are dropped and persisted names survive draft save and reload`, () => {
		const { environment, form } = refreshForm(doctype, { docstatus: 0, ...header });
		const identities = [
			{ name: 'new-mgk-child-temp' }, { name: 'copiedhash', __islocal: 1 },
			{ name: '51heb7m1a7', __islocal: 0 },
		];
		const data = [{ items: identities.map(identity => ({ name: 'Plain', values: { default: {
			...identity, qty: 2, rate: 7, amount: 14,
			purchase_order_item: 'PO-source', against_dc_item: 'DC-source',
		} } })) }];
		form.itemEditor.load_data(data);
		environment.events[doctype].validate(form);
		const payload = JSON.parse(form.doc.item_details);
		assert.deepEqual(payload[0].items.map(entry => entry.values.default.name),
			[undefined, undefined, '51heb7m1a7']);
		assert.ok(payload[0].items.every(entry => entry.name === 'Plain'));
		assert.equal(data[0].items[0].values.default.name, identities[0].name);
		const savedNames = ['freshhash1', 'freshhash2', '51heb7m1a7'];
		payload[0].items.forEach((entry, index) => {
			entry.values.default.name = savedNames[index];
			delete entry.values.default.__islocal;
		});
		form.doc = { ...form.doc, name: 'saved-draft', item_details: null,
			__onload: { item_details: payload } };
		environment.events[doctype].refresh(form);
		environment.events[doctype].validate(form);
		const reloaded = JSON.parse(form.doc.item_details)[0].items;
		assert.deepEqual(reloaded.map(entry => entry.values.default.name), savedNames);
		assert.ok(reloaded.every(entry => entry.values.default.purchase_order_item === 'PO-source'
			&& entry.values.default.against_dc_item === 'DC-source'));
	});

	test(`editor mode ${mode}, permissions, live amounts and read-only lifecycle`, () => {
		const { environment, form } = refreshForm(doctype, { docstatus: 0, ...header });
		const helper = environment.frappe.mgk_yrp;
		assert.equal(helper.item_editor_mode(form.doc), mode);
		const context = form.itemEditor.app.context;
		const locked = ['dc_return', 'grn_po'].includes(mode);
		vm.runInContext('ready.value = true', context);
		assert.equal(vm.runInContext('args.can_create()', context), mode !== 'dc_return');
		assert.equal(vm.runInContext('args.can_edit()', context), !locked);
		assert.equal(vm.runInContext('args.can_remove()', context), !locked);
		assert.equal(vm.runInContext('tableFields.value[0].inline_edit', context), !locked);
		form.itemEditor.load_data([{ items: [{ values: { default: {
			qty: 3, rate: 7, purchase_order_item: 'PO-row', against_dc_item: 'DC-row',
		} } }] }]);
		vm.runInContext('changed()', context);
		assert.equal(form.doc.total_qty, 3);
		assert.equal(form.doc[mode.startsWith('dc') ? 'total_declared_value' : 'total_amount'], 21);
		for (const status of [1, 2, 0]) {
			form.doc.docstatus = status;
			form.itemEditor.update_status();
			assert.equal(vm.runInContext('editable.value', context), status === 0);
		}
	});
}

for (const [doctype, header, mode, link] of [
	['MGK Delivery Challan', { is_return: 1 }, 'dc_return', 'against_dc_item'],
	['MGK Goods Received Note', { against_purchase_order: 1 }, 'grn_po', 'purchase_order_item'],
]) {
	test(`${mode}: load_data hides unlinked cells and preserves linked zero cells after reload`, () => {
		const { environment, form } = refreshForm(doctype, { docstatus: 0, ...header });
		const otherLink = link === 'against_dc_item' ? 'purchase_order_item' : 'against_dc_item';
		const data = [{ primary_attribute: 'Size', primary_attribute_values: ['S', 'M', 'L', 'XL'],
			items: [{ name: 'Tee', values: {
				S: { qty: 4, rate: 10, [link]: 'source-S' },
				M: { qty: 0, rate: 10, [link]: 'source-M' },
				L: { qty: 2, rate: 10, [otherLink]: 'wrong-source' }, XL: null,
			} }] }];
		for (const reload of [false, true]) {
			if (reload) {
				form.doc.name = 'saved-draft';
				form.doc.__onload = { item_details: data };
				environment.events[doctype].refresh(form);
			} else form.itemEditor.load_data(data);
			const items = form.itemEditor.get_items();
			assert.equal(items[0].items.length, 1);
			const values = items[0].items[0].values;
			assert.deepEqual(Object.keys(values), ['S', 'M', 'L', 'XL']);
			assert.equal(values.S.qty, 4);
			assert.equal(values.S[link], 'source-S');
			assert.equal(values.M.qty, 0);
			assert.equal(values.M[link], 'source-M');
			assert.equal(values.L, null);
			assert.equal(values.XL, null);
			vm.runInContext('changed()', form.itemEditor.app.context);
			assert.equal(form.doc.total_qty, 4);
			assert.equal(form.doc[mode === 'dc_return' ? 'total_declared_value' : 'total_amount'], 40);
			environment.events[doctype].validate(form);
			assert.equal(JSON.parse(form.doc.item_details)[0].items[0].values.L, null);
		}
		assert.equal(data[0].items[0].values.L.qty, 2, 'loading preserves the source payload');
	});
}

test("PO picker filters exist on Item and follow the order item group", () => {
	const { form } = refreshForm('MGK Purchase Order', { docstatus: 0 });
	const filters = JSON.parse(vm.runInContext('JSON.stringify(itemFilters())', form.itemEditor.app.context));
	assert.deepEqual(filters, { is_stock_item: 1, disabled: 0, variant_of: ['is', 'not set'] });
	form.doc.item_group = 'Karigan Items';
	assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(itemFilters())', form.itemEditor.app.context)),
		{ ...filters, item_group: 'Karigan Items' });
	const item = JSON.parse(readFileSync(resolve(__dirname,
		'../../../erpnext/erpnext/stock/doctype/item/item.json')));
	for (const field of Object.keys(filters)) assert.ok(item.fields.some(row => row.fieldname === field));
	const context = form.itemEditor.app.context;
	assert.equal(vm.runInContext('validateItem({values: {S: {qty: 2, rate: 5}}})', context), true);
	context.frappe.msgprint = () => {};
	assert.equal(vm.runInContext('validateItem({values: {S: {qty: 2, rate: 0}}})', context), false);
});

test("editor reload uses fresh onload rows and hides child grid", () => {
	const { environment, form } = refreshForm('MGK Purchase Order', { docstatus: 0 });
	const previous = form.itemEditor;
	const data = [{ items: [{ values: { default: { qty: 4, rate: 8, amount: 32, name: 'saved-row' } } }] }];
	form.doc.item_details = '[]';
	form.doc.__onload = { item_details: data };
	const properties = {};
	form.set_df_property = (field, property, value) => { properties[`${field}.${property}`] = value; };
	for (const docstatus of [0, 1, 2]) {
		form.doc.docstatus = docstatus;
		environment.events[form.doctype].refresh(form);
		assert.deepEqual(JSON.parse(JSON.stringify(form.itemEditor.get_items())), data);
		assert.equal(vm.runInContext('editable.value', form.itemEditor.app.context), docstatus === 0);
	}
	assert.equal(previous.app.unmounted, true);
	assert.equal(properties['items.hidden'], 1);
	assert.equal(properties['items.reqd'], 0);
	const editor = form.itemEditor;
	environment.events[form.doctype].refresh(form);
	assert.equal(form.itemEditor, editor);
});

for (const reload of ['replacement document', 'modified timestamp']) {
	test(`editor discards edits on ${reload} and preserves edits during ordinary refresh`, () => {
		const data = [{ items: [{ values: { default: { qty: 5, rate: 2 } } }] }];
		const { environment, form } = refreshForm('MGK Purchase Order', {
			name: 'PO-1', docstatus: 0, modified: '2026-10-29 10:00:00', __onload: { item_details: data },
		});
		const editor = form.itemEditor;
		editor.get_items()[0].items[0].values.default.qty = 10;
		environment.events[form.doctype].refresh(form);
		assert.equal(form.itemEditor, editor);
		assert.equal(editor.get_items()[0].items[0].values.default.qty, 10);
		if (reload === 'replacement document') form.doc = JSON.parse(JSON.stringify(form.doc));
		else form.doc.modified = '2026-10-29 10:01:00';
		environment.events[form.doctype].refresh(form);
		assert.equal(editor.app.unmounted, true);
		assert.equal(form.itemEditor.get_items()[0].items[0].values.default.qty, 5);
		environment.events[form.doctype].validate(form);
		assert.equal(JSON.parse(form.doc.item_details)[0].items[0].values.default.qty, 5);
	});
}

test('copied row hydration cannot overwrite a replacement document or explicitly loaded data', async () => {
	for (const replacement of ['document', 'payload']) {
		const { environment, form } = refreshForm('MGK Purchase Order', {
			docstatus: 0, items: [{ name: 'new-child', item: 'Tee-S', qty: 5 }],
		}, undefined, false);
		let finish;
		environment.frappe.call = () => new Promise(resolve => { finish = resolve; });
		const loading = environment.events[form.doctype].refresh(form);
		const data = [{ items: [{ values: { default: { qty: 2, rate: 7, amount: 14 } } }] }];
		if (replacement === 'document') {
			form.doc = { doctype: form.doctype, docstatus: 0, __onload: { item_details: data } };
			environment.events[form.doctype].refresh(form);
		} else environment.frappe.mgk_yrp.load_item_editor(form, data);
		const editor = form.itemEditor;
		finish({ message: [{ items: [{ values: { default: { qty: 10 } } }] }] });
		await loading;
		assert.equal(form.itemEditor, editor);
		assert.deepEqual(JSON.parse(JSON.stringify(editor.get_items())), data);
	}
});

test("GRN untick and PO change clear editor and selection loads mapped rows and received type", async () => {
	const doctype = 'MGK Goods Received Note';
	const { environment, form } = refreshForm(doctype,
		{ docstatus: 0, against_purchase_order: 1, purchase_order: 'PO-1' });
	const data = [{ items: [{ values: { default: {
		qty: 5, rate: 4, amount: 20, purchase_order_item: 'row',
	} } }] }];
	form.itemEditor.load_data(data);
	form.doc.against_purchase_order = 0;
	await environment.events[doctype].against_purchase_order(form);
	assert.equal(JSON.stringify(form.itemEditor.get_items()), '[]');
	assert.equal(form.doc.purchase_order, '');
	form.doc.against_purchase_order = 1;
	form.doc.purchase_order = 'PO-2';
	let finish;
	environment.frappe.call = () => new Promise(resolve => { finish = resolve; });
	const fetching = environment.events[doctype].purchase_order(form);
	assert.equal(JSON.stringify(form.itemEditor.get_items()), '[]');
	await new Promise(resolve => setImmediate(resolve));
	finish({ message: { supplier: 'Supplier', warehouse: 'Warehouse',
		total_qty: 5, total_amount: 20, __onload: { item_details: data } } });
	await fetching;
	assert.deepEqual(JSON.parse(JSON.stringify(form.itemEditor.get_items())), data);
	assert.equal(form.doc.received_type, undefined);
	form.doc.purchase_order = '';
	await environment.events[doctype].purchase_order(form);
	assert.equal(JSON.stringify(form.itemEditor.get_items()), '[]');
});

for (const navigation of ['before first await', 'during PO fetch', 'during header update']) {
	test(`GRN PO fetch ignores a replacement document ${navigation}`, async () => {
		const doctype = 'MGK Goods Received Note';
		const { environment, form } = refreshForm(doctype, {
			name: 'GRN-A', docstatus: 0, against_purchase_order: 1, purchase_order: 'PO-1',
		});
		let finish;
		environment.frappe.call = () => new Promise(resolve => { finish = resolve; });
		let finishHeaders;
		const setValue = form.set_value;
		if (navigation === 'during header update') form.set_value = function (values) {
			const result = setValue.call(this, values);
			return values.supplier ? new Promise(resolve => { finishHeaders = resolve; }) : result;
		};
		const pending = environment.events[doctype].purchase_order(form);
		if (navigation !== 'before first await') await new Promise(resolve => setImmediate(resolve));
		const mapped = [{ items: [{ values: { default: {
			qty: 10, rate: 4, purchase_order_item: 'PO-row',
		} } }] }];
		const response = { message: { supplier: 'A', warehouse: 'A', delivery_location: 'A',
			total_qty: 10, total_amount: 40, __onload: { item_details: mapped } } };
		if (navigation === 'during header update') {
			finish(response);
			await new Promise(resolve => setImmediate(resolve));
		}
		const data = [{ items: [{ values: { default: {
			qty: 2, rate: 3, amount: 6, purchase_order_item: 'B-row',
		} } }] }];
		form.doc = { doctype, name: 'GRN-B', docstatus: 0, against_purchase_order: 1,
			purchase_order: 'PO-1', supplier: 'B', warehouse: 'B',
			delivery_location: 'B', total_qty: 2, total_amount: 6, __onload: { item_details: data } };
		environment.events[doctype].refresh(form);
		const snapshot = JSON.stringify(form.doc);
		const editor = form.itemEditor;
		if (navigation === 'during PO fetch') finish(response);
		if (navigation === 'during header update') finishHeaders();
		await pending;
		if (navigation === 'before first await') assert.equal(finish, undefined);
		assert.equal(JSON.stringify(form.doc), snapshot);
		assert.equal(form.itemEditor, editor);
		assert.deepEqual(JSON.parse(JSON.stringify(editor.get_items())), data);
	});
}

test('GRN PO request sequence rejects an older response after PO-1 to PO-2 to PO-1', async () => {
	const doctype = 'MGK Goods Received Note';
	const { environment, form } = refreshForm(doctype, { docstatus: 0, against_purchase_order: 1 });
	const responses = [];
	environment.frappe.call = ({ args }) => new Promise(resolve => {
		responses.push({ source: args.source_name, finish: resolve });
	});
	const pending = [];
	for (const source of ['PO-1', 'PO-2', 'PO-1']) {
		form.doc.purchase_order = source;
		pending.push(environment.events[doctype].purchase_order(form));
		await new Promise(resolve => setImmediate(resolve));
	}
	const data = [{ items: [{ values: { default: { qty: 2, rate: 3, amount: 6, purchase_order_item: 'latest' } } }] }];
	responses[2].finish({ message: { supplier: 'Latest', warehouse: 'Latest',
		total_qty: 2, total_amount: 6, __onload: { item_details: data } } });
	await pending[2];
	const snapshot = JSON.stringify(form.doc);
	const editor = form.itemEditor;
	for (const index of [1, 0]) {
		responses[index].finish({ message: { supplier: 'Stale',
			total_qty: 10, __onload: { item_details: [] } } });
		await pending[index];
	}
	assert.deepEqual(responses.map(response => response.source), ['PO-1', 'PO-2', 'PO-1']);
	assert.equal(JSON.stringify(form.doc), snapshot);
	assert.equal(form.itemEditor, editor);
	assert.deepEqual(JSON.parse(JSON.stringify(editor.get_items())), data);
});

test('dimensions enabled and editable except return rows; no header logic', () => {
	const source = readFileSync(resolve(editorDirectory, 'ItemEditor.vue'), 'utf8');
	assert.match(source, /:show-dimensions="true"/);
	assert.match(source, /:lock-dimensions-on-edit="props.mode === 'dc_return'"/);
	for (const doctype of editorDoctypes) {
		const name = doctype.toLowerCase().replaceAll(' ', '_');
		assert.doesNotMatch(readFileSync(resolve(doctypes, name, `${name}.js`), 'utf8'), /received_type/);
	}
	assert.doesNotMatch(readFileSync(resolve(editorDirectory, 'item_editor.js'), 'utf8'), /received_type/);
});

for (const mode of ['po', 'dc', 'grn_job', 'grn_po']) {
	test(`${mode}: dimensions default after mount, late controls and add; user choice preserved`, async () => {
		const environment = desk();
		let totals;
		let dirty = 0;
		const props = { frm: { doc: { docstatus: 0 },
			set_value(value) { totals = value; }, dirty() { dirty++; } }, mode };
		const { context, exposed, emit } = vueEditor(environment, props);
		let control;
		context.element = { isConnected: true, querySelector: () => control ? { fieldobj: control } : null };
		vm.runInContext('root.value = element', context);
		environment.frappe.call = async () => ({ message: { defaults: { received_type: 'Accepted' }, po_entries: [] } });
		await environment.mounted();
		let value = '';
		control = { get_value: () => value, set_value: next => { value = next; } };
		environment.mutate();
		assert.equal(value, 'Accepted');
		value = 'Rejected';
		environment.mutate();
		assert.equal(value, 'Rejected');
		const data = [{ items: [{ values: { default: { qty: 10, rate: 2, purchase_order_item: 'po-row' } } }] }];
		exposed.load_data(data);
		const cell = exposed.get_items()[0].items[0].values.default;
		cell.qty = 6;
		await emit('itemupdated');
		assert.equal(value, 'Rejected');
		assert.equal(totals.total_qty, 6);
		cell.rate = 3;
		await emit('itemupdated');
		assert.equal(value, 'Rejected');
		assert.equal(totals[mode === 'dc' ? 'total_declared_value' : 'total_amount'], 18);
		assert.equal(dirty, 2);
		await emit('itemadded');
		assert.equal(value, 'Accepted');
		value = '';
		await emit('itemadded');
		assert.equal(value, 'Accepted');
	});
}

test('no configured dimensions prefills no controls', () => {
	const { environment, form } = refreshForm('MGK Purchase Order', { docstatus: 0 });
	vm.runInContext('prefillDimensions()', form.itemEditor.app.context);
	assert.equal(environment.mutate, undefined);
});

test('dimension mount prefills controls already rendered and preserves a choice during the request', async () => {
	for (const initial of ['', 'Rejected']) {
		const environment = desk();
		const { context } = vueEditor(environment, { frm: { doc: { docstatus: 0 } }, mode: 'po' });
		let value = initial;
		const fieldobj = { get_value: () => value, set_value: next => { value = next; } };
		context.element = { isConnected: true, querySelector: () => ({ fieldobj }) };
		vm.runInContext('root.value = element', context);
		environment.frappe.call = async () => ({ message: { defaults: { received_type: 'Accepted' }, po_entries: [] } });
		await environment.mounted();
		assert.equal(value, initial || 'Accepted');
	}
});

test('PO split Add Item restricts picker and hydrates rates, links and pending per cell', () => {
	const environment = desk();
	const { context } = vueEditor(environment, { frm: { doc: { docstatus: 0 } }, mode: 'grn_po' });
	context.source = { name: 'Tee', attributes: {}, values: { S: { purchase_order_item: 'po-S',
		rate: 50, pending_qty: 10, allowed_qty: 10, uom: 'Nos', stock_uom: 'Nos', conversion_factor: 1 } } };
	vm.runInContext('context.value.po_entries = [source]', context);
	assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(itemFilters().name)', context)), ['in', ['Tee']]);
	for (const received_type of ['Accepted', 'Rejected']) {
		context.entry = { name: 'Tee', attributes: {}, dimensions: { received_type }, values: { S: { qty: 4 } } };
		assert.equal(vm.runInContext('validateItem(entry)', context), true);
		assert.equal(context.entry.values.S.purchase_order_item, 'po-S');
		assert.equal(context.entry.values.S.rate, 50);
		assert.equal(context.entry.values.S.pending_qty, 10);
		assert.equal(context.entry.dimensions.received_type, received_type);
	}
	const messages = [];
	environment.frappe.msgprint = message => messages.push(message);
	vm.runInContext('context.value.po_entries.push(source); delete entry.values.S.purchase_order_item', context);
	assert.equal(vm.runInContext('validateItem(entry)', context), false);
	assert.equal(messages.length, 1);
});

for (const docstatus of [0, 1, 2]) {
	for (const pending_qty of [0, 10]) {
		test(`PO Create GRN visibility: status ${docstatus}, pending ${pending_qty}`, () => {
			assert.deepEqual(buttons("MGK Purchase Order", { docstatus, items: [{ pending_qty }] }),
				docstatus === 1 && pending_qty > 0 ? ["Create GRN", "Mark as Received"] : []);
		});
	}
}

test("PO Create GRN respects create permission", () => {
	assert.deepEqual(buttons("MGK Purchase Order", { docstatus: 1, items: [{ pending_qty: 10 }] },
		{ "MGK Goods Received Note": false }), []);
});

test('PO connections hide only the DC new button through dashboard after_refresh', () => {
	const { environment, form } = refreshForm('MGK Purchase Order', { docstatus: 1, items: [] }, {}, false);
	vm.runInContext(readFileSync(resolve(__dirname,
		'../../../frappe/frappe/public/js/frappe/form/dashboard.js'), 'utf8')
		.replace(/^import .*;$/gm, ''), environment.context);
	const buttons = ['MGK Delivery Challan', 'MGK Goods Received Note'].map(doctype => ({
		doctype, hidden: true, display: '',
	}));
	environment.context.$ = element => ({
		attr: name => { assert.equal(name, 'data-doctype'); return element.doctype; },
		removeClass: name => { assert.equal(name, 'hidden'); element.hidden = false; },
	});
	form.can_create = () => true;
	form.dashboard = {
		frm: form, observe_link_render() {},
		links_area: { body: { find(selector) {
			if (selector === '.btn-new') return { each: callback => buttons.forEach((button, i) => callback(i, button)) };
			assert.equal(selector, '.document-link[data-doctype="MGK Delivery Challan"] .btn-new');
			return { hide: () => { buttons[0].display = 'none'; } };
		} } },
	};
	for (let refresh = 0; refresh < 2; refresh++) {
		environment.events['MGK Purchase Order'].refresh(form);
		environment.frappe.ui.form.Dashboard.prototype.after_refresh.call(form.dashboard);
		assert.equal(buttons[0].display, 'none');
		assert.equal(buttons[1].display, '');
		assert.equal(buttons[1].hidden, false, 'GRN new button remains available');
	}
});

test('PO receipt metadata reuses the company flag and adds source connections', () => {
	const meta = JSON.parse(readFileSync(resolve(doctypes, 'mgk_purchase_order/mgk_purchase_order.json')));
	assert.ok(meta.field_order.indexOf('deliver_to_supplier') < meta.field_order.indexOf('delivery_location'));
	const process = meta.fields.find(field => field.fieldname === 'process_name');
	assert.equal(process.options, 'YRP Process');
	assert.equal(process.mandatory_depends_on, 'eval:doc.deliver_to_supplier');
	for (const link_doctype of ['MGK Goods Received Note', 'MGK Delivery Challan']) {
		assert.ok(meta.links.some(link => link.link_doctype === link_doctype && link.link_fieldname === 'purchase_order'));
	}
	const fields = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/custom_field.json')));
	const headOffice = fields.find(field => field.name === 'Supplier-mgk_is_head_office');
	assert.equal(headOffice.fieldtype, 'Check');
	assert.equal(headOffice.label, 'Is Head Office');
	assert.equal(headOffice.module, 'MGK YRP');
	assert.equal(headOffice.insert_after, 'is_company_location');
	assert.ok(!fields.some(field => field.dt === 'Supplier' && field.fieldname === 'is_company_location'));
});

test('DC receipt sources are hidden when empty and are not copied', () => {
	const meta = JSON.parse(readFileSync(resolve(doctypes, 'mgk_delivery_challan/mgk_delivery_challan.json')));
	for (const name of ['purchase_order', 'goods_received_note']) {
		const field = meta.fields.find(field => field.fieldname === name);
		assert.equal(field.read_only, 1);
		assert.equal(field.no_copy, 1);
		assert.ok(field.depends_on);
	}
	const environment = desk();
	const copy = copyDocument(environment, { doctype: 'MGK Delivery Challan', name: 'DC',
		purchase_order: 'PO', goods_received_note: 'GRN', items: [] });
	assert.ok(!copy.purchase_order);
	assert.ok(!copy.goods_received_note);
});

test('PO Mark as Received also requires DC create permission for direct delivery', () => {
	const doc = { docstatus: 1, deliver_to_supplier: 1, items: [{ pending_qty: 10 }] };
	assert.deepEqual(buttons('MGK Purchase Order', doc), ['Create GRN', 'Mark as Received']);
	assert.deepEqual(buttons('MGK Purchase Order', doc, { 'MGK Delivery Challan': false }), ['Create GRN']);
	assert.deepEqual(buttons('MGK Purchase Order', { ...doc, deliver_to_supplier: 0 },
		{ 'MGK Delivery Challan': false }), ['Create GRN', 'Mark as Received']);
	assert.deepEqual(buttons('MGK Purchase Order', { ...doc, status: 'Completed', items: [{ pending_qty: 0 }] }), []);
});

for (const deliver_to_supplier of [0, 1]) {
	test(`PO Mark as Received confirms, freezes, prevents duplicates and links results: direct ${deliver_to_supplier}`, async () => {
		const { environment, form } = refreshForm('MGK Purchase Order', { name: 'PO-1', docstatus: 1,
			delivery_location: 'Knit Works', deliver_to_supplier, process_name: 'Knitting', items: [{ pending_qty: 10 }] }, undefined, false);
		let click, confirm, finish, request, message;
		const disabled = [];
		form.add_custom_button = (label, callback) => {
			if (label === 'Mark as Received') click = callback;
			return { prop: (name, value) => { assert.equal(name, 'disabled'); disabled.push(value); } };
		};
		let reloads = 0, calls = 0;
		form.reload_doc = async () => { reloads++; };
		environment.frappe.confirm = (text, yes) => { confirm = yes; assert.equal(text, deliver_to_supplier
			? 'Create and submit a GRN for the full pending quantity at Head Office, then a Delivery Challan from Head Office to Knit Works for process Knitting?'
			: 'Create and submit a GRN for the full pending quantity at Knit Works?'); };
		environment.frappe.call = args => { calls++; request = args; return new Promise(resolve => { finish = resolve; }); };
		environment.frappe.utils.get_form_link = (doctype, name, html) => {
			assert.equal(html, true);
			return `<a href="${doctype}/${name}">${name}</a>`;
		};
		environment.frappe.msgprint = value => { message = value; };
		environment.events[form.doctype].refresh(form);
		click();
		assert.equal(calls, 0);
		const pending = confirm();
		confirm();
		assert.equal(calls, 1);
		assert.equal(request.method, 'mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.mark_as_received');
		assert.equal(request.args.source_name, 'PO-1');
		assert.equal(request.freeze, true);
		assert.equal(disabled.at(-1), true);
		finish({ message: { goods_received_note: 'GRN-1', delivery_challan: deliver_to_supplier ? 'DC-1' : null } });
		await pending;
		assert.equal(reloads, 1);
		assert.match(JSON.stringify(message), /MGK Goods Received Note\/GRN-1/);
		if (deliver_to_supplier) assert.match(JSON.stringify(message), /MGK Delivery Challan\/DC-1/);
		else assert.doesNotMatch(JSON.stringify(message), /MGK Delivery Challan/);
		assert.equal(disabled.at(-1), false);
	});
}

test('PO Mark as Received enables retry after failure without a success message', async () => {
	const { environment, form } = refreshForm('MGK Purchase Order', { name: 'PO', docstatus: 1,
		items: [{ pending_qty: 1 }] }, undefined, false);
	let click, confirm;
	const disabled = [];
	form.add_custom_button = (label, handler) => {
		if (label === 'Mark as Received') click = handler;
		return { prop: (key, value) => disabled.push(value) };
	};
	form.reload_doc = () => assert.fail('failed receipt must not show success');
	environment.frappe.msgprint = form.reload_doc;
	environment.frappe.confirm = (text, yes) => { confirm = yes; };
	environment.frappe.call = async () => { throw new Error('DC failed'); };
	environment.events[form.doctype].refresh(form);
	click();
	await assert.rejects(confirm(), /DC failed/);
	assert.deepEqual(disabled, [true, false]);
});

test('U6 PO supplier excludes company locations; handling supplier stays unchanged', () => {
	const { environment, form } = refreshForm('MGK Purchase Order', { docstatus: 0 });
	const queries = {};
	form.set_query = (field, query) => { queries[field] = query; };
	environment.events[form.doctype].setup(form);
	for (const deliver_to_supplier of [0, 1]) {
		form.doc.deliver_to_supplier = deliver_to_supplier;
		assert.deepEqual(JSON.parse(JSON.stringify(queries.delivery_location().filters)),
			{ disabled: 0, is_company_location: deliver_to_supplier ? 0 : 1 });
		assert.deepEqual(JSON.parse(JSON.stringify(queries.supplier().filters)), { disabled: 0, is_company_location: 0 });
		assert.deepEqual(JSON.parse(JSON.stringify(queries.handling_supplier().filters)), { disabled: 0 });
	}
});

for (const is_company_location of [0, 1]) {
	test(`PO delivery toggle clears mismatches, preserves matches, refills own location: company ${is_company_location}`, async () => {
		const { environment, form } = refreshForm('MGK Purchase Order', { docstatus: 0,
			delivery_location: 'Current', warehouse: 'Current WH', deliver_to_supplier: is_company_location });
		environment.frappe.db = { get_value: async () => ({ message: { is_company_location } }) };
		environment.frappe.call = async () => ({ message: { location: 'Own', warehouse: 'Own WH' } });
		const toggle = environment.events[form.doctype].deliver_to_supplier;
		await toggle(form);
		assert.equal(form.doc.delivery_location, is_company_location ? '' : 'Own');
		assert.equal(form.doc.warehouse, is_company_location ? '' : 'Own WH');
		form.doc.delivery_location = 'Matches'; form.doc.warehouse = 'Matches WH';
		form.doc.deliver_to_supplier = 1 - is_company_location;
		await toggle(form);
		assert.equal(form.doc.delivery_location, 'Matches');
		assert.equal(form.doc.warehouse, 'Matches WH');
	});
}

test('PO onload only defaults own location when not delivering to a supplier', async () => {
	const { environment, form } = refreshForm('MGK Purchase Order', { docstatus: 0, deliver_to_supplier: 1 });
	let calls = 0;
	environment.frappe.call = async () => { calls++; return { message: { location: 'Own', warehouse: 'Own WH' } }; };
	await environment.events[form.doctype].onload(form);
	assert.equal(calls, 0);
	form.doc.deliver_to_supplier = 0;
	await environment.events[form.doctype].onload(form);
	assert.equal(form.doc.delivery_location, 'Own');
	assert.equal(form.doc.warehouse, 'Own WH');
});

for (const docstatus of [0, 1, 2]) {
	for (const close_status of ["Open", "Closed", "Reopening"]) {
		for (const is_return of [0, 1]) {
			test(`DC action visibility: status ${docstatus}, ${close_status}, return ${is_return}`, () => {
				assert.deepEqual(buttons("MGK Delivery Challan", { docstatus, close_status, is_return }),
					docstatus === 1 && close_status === "Open" && !is_return
						? ["Return", "Close", "Create GRN", "Update Plan"] : []);
			});
		}
	}
}

test("DC Return and Close respect their create permissions separately", () => {
	const doc = { docstatus: 1, close_status: "Open" };
	assert.deepEqual(buttons("MGK Delivery Challan", doc, { "MGK Delivery Challan": false }),
		["Close", "Create GRN", "Update Plan"]);
	assert.deepEqual(buttons("MGK Delivery Challan", doc, { "MGK Delivery Challan Close": false }),
		["Return", "Create GRN", "Update Plan"]);
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
	["MGK Goods Received Note", ["MGK Purchase Invoice", "MGK Delivery Challan", "MGK Delivery Challan Close",
		"YRP Stock Ledger Entry", "YRP Repost Item Valuation", "YRP Stock Valuation Adjustment",
		"YRP Stock Valuation Production Link"]],
	["MGK Delivery Challan", ["MGK Delivery Challan", "MGK Goods Received Note",
		"MGK Delivery Challan Close", "YRP Stock Ledger Entry", "YRP Repost Item Valuation",
		"YRP Stock Valuation Adjustment", "YRP Stock Valuation Production Link"]],
	["MGK Purchase Order", ["MGK Goods Received Note", "MGK Delivery Challan"]],
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

test("Stock User Close displays server valuation status without an SVA request", () => {
	const { environment, form } = refreshForm("MGK Delivery Challan Close", { docstatus: 1 });
	form.doc.stock_valuation_adjustment = "SVA-1";
	form.doc.__onload = { valuation_status: "Reversal Queued" };
	let displayed = false;
	form.dashboard = { add_indicator: (label, color) => {
		displayed = true;
		assert.equal(label, "Valuation: Reversal Queued");
		assert.equal(color, "orange");
	} };
	environment.frappe.db = { get_value: () => assert.fail("SVA requires no client read permission") };
	environment.frappe.call = () => assert.fail("status is supplied by the parent document");
	environment.events[form.doctype].refresh(form);
	assert.equal(displayed, true);
});

for (const [doctype, pending, finished] of [
	["MGK Delivery Challan Close", { reopen_status: "Reversing" }, { reopen_status: "Reopened" }],
	["MGK Delivery Challan Close", { reopen_status: "Reopening" }, { reopen_status: "Reopened" }],
	["MGK Purchase Invoice", { __onload: { valuation_pending: true } },
		{ __onload: { valuation_pending: false } }],
]) {
	test(`${doctype}: Amend waits for ${JSON.stringify(pending)} and retains permissions`, () => {
		const { environment, form } = refreshForm(doctype, { docstatus: 2, ...pending });
		attachToolbar(environment, form);
		environment.events[doctype].setup(form);
		assert.equal(form.toolbar.can_amend(), false);
		form.doc = { docstatus: 2, ...finished };
		assert.equal(form.toolbar.can_amend(), true);
		form.perm[0].amend = false;
		assert.equal(form.toolbar.can_amend(), false);
		form.perm[0].amend = true;
		form.doc.docstatus = 1;
		assert.equal(form.toolbar.can_amend(), false);
	});

	for (const amended of [false, "amended-document"]) {
		for (const path of ["fresh load", "refresh"]) {
			test(`${doctype}: ${path} rejects late Amend (${amended}) during ${JSON.stringify(pending)}`, async () => {
				const { environment, form } = refreshForm(doctype,
					{ doctype, name: "test", docstatus: 2, ...finished }, undefined, false);
				attachToolbar(environment, form);
				let finish;
				environment.frappe.xcall = (method, args) => {
					assert.equal(method, "frappe.client.is_document_amended");
					assert.equal(args.docname, "test");
					return new Promise(resolve => { finish = resolve; });
				};
				if (path === "refresh") environment.events[doctype].setup(form);
				else Object.assign(form.doc, pending);
				form.toolbar.set_primary_action();
				assert.equal(typeof finish, "function", "lookup begins before the guard takes effect");
				if (path === "fresh load") environment.events[doctype].setup(form);
				Object.assign(form.doc, pending);
				for (let count = 0; count < 2; count++) {
					form.toolbar.set_primary_action();
					environment.events[doctype].refresh(form);
				}
				finish(amended);
				await new Promise(resolve => setImmediate(resolve));
				assert.equal(form.page.btn_primary.visible, false);
				assert.equal(form.page.btn_secondary.visible, false);
				Object.assign(form.doc, finished);
				form.toolbar.set_primary_action();
				finish(false);
				await new Promise(resolve => setImmediate(resolve));
				assert.equal(form.page.btn_primary.visible, true, "Amend returns after completion");
				assert.equal(form.page.btn_primary.label, "Amend");
			});
		}
	}
}

function toolbarButton() {
	return {
		visible: false,
		addClass() { this.visible = false; return this; },
		unbind() { return this; }, removeAttr() { return this; },
		prop() { return this; }, wrap() { return this; }, parent() { return this; },
		attr() { return this; }, tooltip() { return this; },
	};
}

function attachToolbar(environment, form) {
	const source = readFileSync(resolve(__dirname,
		"../../../frappe/frappe/public/js/frappe/form/toolbar.js"), "utf8");
	vm.runInContext(source.slice(source.indexOf("frappe.ui.form.Toolbar =")), environment.context);
	const page = readFileSync(resolve(__dirname,
		"../../../frappe/frappe/public/js/frappe/ui/page.js"), "utf8");
	const start = page.indexOf("\tset_primary_action(");
	const end = page.indexOf("\n\t// Close and tear down", start);
	Object.setPrototypeOf(form.page,
		vm.runInContext(`(class {${page.slice(start, end)}}).prototype`, environment.context));
	delete form.page.clear_secondary_action;
	Object.assign(form.page, {
		btn_primary: toolbarButton(), btn_secondary: toolbarButton(), clear_user_actions() {},
		set_action(button, options) { button.label = options.label; button.visible = true; },
	});
	environment.context.cint = Number;
	form.perm = [{ amend: true }];
	form.action_perm_type_map = { Amend: "amend" };
	form.toolbar = Object.assign(Object.create(environment.frappe.ui.form.Toolbar.prototype), {
		frm: form, page: form.page, has_workflow: () => false,
	});
	form.set_query = () => {};
	form.get_field = field => form.fields_dict[field];
	environment.frappe.db = { get_value: () => assert.fail("use status supplied in the document") };
}

test("PI in-place Cancel hides Amend until the response's reversal finishes", async () => {
	const doctype = "MGK Purchase Invoice";
	const { environment, form } = refreshForm(doctype, { doctype, name: "PI-1", docstatus: 1 });
	attachToolbar(environment, form);
	environment.events[doctype].setup(form);
	environment.frappe.xcall = async () => false;
	form.reload_doc = () => assert.fail("Cancel must supply the status without a reload");
	form.doc = { doctype, name: "PI-1", docstatus: 2, __onload: { valuation_pending: true } };
	for (let count = 0; count < 2; count++) {
		form.toolbar.set_primary_action();
		environment.events[doctype].refresh(form);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(form.toolbar.can_amend(), false);
		assert.equal(form.page.btn_primary.visible, false);
		assert.equal(form.page.btn_secondary.visible, false);
	}
	form.doc.__onload.valuation_pending = false;
	form.toolbar.set_primary_action();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(form.page.btn_primary.visible, true);
	assert.equal(form.page.btn_primary.label, "Amend");
});

test("Close distinguishes draft previews from rates recorded at close", () => {
	const { environment, form } = refreshForm("MGK Delivery Challan Close", { docstatus: 0 });
	const labels = {};
	form.set_df_property = (field, property, value) => { labels[field] = value; };
	form.fields_dict.outputs.grid = {
		update_docfield_property(field, property, value) { labels[field] = value; }, refresh() {},
	};
	let intro;
	form.set_intro = message => { intro = message; };
	for (const docstatus of [0, 1, 2, 0]) {
		form.doc = { docstatus, outputs: [{}], output_stock_uom: "Kg", value_per_unit: 3100 / 60 };
		environment.events[form.doctype].refresh(form);
		assert.equal(intro, docstatus === 0 ? "Adds ₹51.67 per Kg to 1 GRN rows"
			: "At close: added ₹51.67 per Kg to 1 GRN rows");
		assert.equal(labels.value_per_unit, docstatus === 0 ? "Value Per Unit" : "Value Per Unit at Close");
		assert.equal(labels.allocated_rate, docstatus === 0 ? "Allocated Rate" : "Allocated Rate at Close");
	}
});

test("Close hides uncomputed draft gaps and restores saved consumption values", () => {
	const { environment, form } = refreshForm("MGK Delivery Challan Close", { docstatus: 0 });
	const hidden = {};
	form.set_df_property = (field, property, value) => { if (property === "hidden") hidden[field] = value; };
	form.fields_dict.items.grid = {
		update_docfield_property(field, property, value) { hidden[field] = value; }, refresh() {},
	};
	for (const docstatus of [0, 1, 2, 0]) {
		form.doc = { docstatus, total_value_gap: docstatus === 0 ? 0 : 125 };
		environment.events[form.doctype].refresh(form);
		for (const field of ["total_value_gap", "consumed_value", "value_gap"]) {
			assert.equal(hidden[field], docstatus === 0, `${field} at docstatus ${docstatus}`);
		}
	}
});

test("Close hides draft output allocations and restores recorded values", () => {
	const { environment, form } = refreshForm("MGK Delivery Challan Close", { docstatus: 0 });
	const hidden = {};
	let refreshed = 0;
	form.fields_dict.outputs.grid = {
		update_docfield_property(field, property, value) {
			if (property === "hidden") hidden[field] = value;
		},
		refresh() { refreshed++; },
	};
	for (const docstatus of [0, 1, 2, 0]) {
		const allocated_value = docstatus === 0 ? 0 : 500;
		const allocated_rate = docstatus === 0 ? 0 : 500 / 12;
		form.doc = { docstatus, outputs: [{ allocated_value, allocated_rate }] };
		environment.events[form.doctype].refresh(form);
		for (const field of ["allocated_value", "allocated_rate"]) {
			assert.equal(hidden[field], docstatus === 0, `${field} at docstatus ${docstatus}`);
		}
		assert.equal(form.doc.outputs[0].allocated_value, allocated_value);
		assert.equal(form.doc.outputs[0].allocated_rate, allocated_rate);
	}
	assert.equal(refreshed, 4);
});

test("Close write-off intro distinguishes previews from the value recorded at close", () => {
	const { environment, form } = refreshForm("MGK Delivery Challan Close", { docstatus: 0 });
	let intro;
	form.set_intro = message => { intro = message; };
	for (const docstatus of [0, 1]) {
		form.doc = { docstatus, outputs: [], loss_value: 125 };
		environment.events[form.doctype].refresh(form);
		assert.equal(intro, docstatus === 0 ? "No linked GRN: ₹125.00 will be written off"
			: "At close: ₹125.00 was written off (no linked GRN)");
	}
});

test('J7 DC mapped GRN and J11 popup actions keep existing actions', () => {
	const { environment, form } = refreshForm('MGK Delivery Challan',
		{ name: 'DC-1', docstatus: 1, close_status: 'Open' }, undefined, false);
	const actions = {};
	form.add_custom_button = (label, action) => { actions[label] = action; };
	environment.events[form.doctype].refresh(form);
	let mapped, planned;
	environment.frappe.model.open_mapped_doc = args => { mapped = args; };
	environment.frappe.mgk_yrp.open_plan_dialog = frm => { planned = frm; };
	actions['Create GRN'](); actions['Update Plan']();
	assert.equal(mapped.method, 'mgk_yrp.job_work.grn_from_dc.make_job_work_grn');
	assert.equal(mapped.frm, form);
	assert.equal(planned, form);
	assert.ok(actions.Return && actions.Close);
});

for (const permission of ['create', 'write', 'none']) {
	test(`J11 Update Plan respects ${permission} permission in Frappe boot lists`, () => {
		const { environment, form, shown } = refreshForm('MGK Delivery Challan',
			{ name: 'DC-1', docstatus: 1, close_status: 'Open' }, undefined, false);
		const plan = 'MGK Process Planning';
		environment.frappe.boot = { user: {
			can_create: ['MGK Goods Received Note', 'MGK Delivery Challan', 'MGK Delivery Challan Close'],
			in_create: permission === 'create' ? [plan] : [],
			can_write: permission === 'none' ? [] : [plan],
		} };
		for (const action of ['can_create', 'can_write']) {
			environment.frappe.model[action] = doctype => environment.frappe.boot.user[action].includes(doctype);
		}
		assert.equal(environment.frappe.model.can_create(plan), false);
		environment.events[form.doctype].refresh(form);
		assert.equal(shown.includes('Update Plan'), permission !== 'none');
		assert.ok(shown.includes('Create GRN'));
	});
}

test('J7 and J11 permission gates and internal transfers', () => {
	const doc = { docstatus: 1, close_status: 'Open' };
	for (const permission of ['MGK Goods Received Note', 'MGK Process Planning', 'write:MGK Process Planning']) {
		const shown = buttons('MGK Delivery Challan', doc, { [permission]: false });
		assert.ok(!shown.includes(permission === 'MGK Goods Received Note' ? 'Create GRN' : 'Update Plan'));
	}
	const internal = buttons('MGK Delivery Challan', { ...doc, is_internal_transfer: 1 });
	assert.ok(!internal.includes('Create GRN') && !internal.includes('Update Plan'));
});

test('J7 DC list maps selected names and syncs before routing', async () => {
	const environment = desk();
	load(environment, 'MGK Delivery Challan', '_list');
	let action, request;
	const events = [];
	environment.frappe.call = async args => { request = args; return { message: { name: 'GRN-new' } }; };
	environment.frappe.model.sync = doc => events.push(['sync', doc.name]);
	environment.frappe.set_route = (...route) => events.push(route);
	const listview = { page: { add_actions_menu_item(label, handler) {
		assert.equal(label, 'Create GRN'); action = handler;
	} }, get_checked_items: () => [{ name: 'DC-1' }, { name: 'DC-2' }] };
	environment.frappe.listview_settings['MGK Delivery Challan'].onload(listview);
	await action();
	assert.equal(request.method, 'mgk_yrp.job_work.grn_from_dc.make_job_work_grn');
	assert.deepEqual(Array.from(request.args.source_names), ['DC-1', 'DC-2']);
	assert.deepEqual(events, [['sync', 'GRN-new'], ['Form', 'MGK Goods Received Note', 'GRN-new']]);
	listview.get_checked_items = () => [];
	await assert.rejects(action(), /Select/);
});

for (const mode of ['grn_job', 'plan']) {
	test(`J8 ${mode} split copies only occupied cells and Remove All clears groups`, () => {
		const environment = desk();
		const form = { doc: { docstatus: 0 }, set_value() {}, dirty() {} };
		const { context, exposed } = vueEditor(environment, { frm: form, mode });
		exposed.load_data([{ attributes: ['Colour'], primary_attribute: 'Size', items: [{
			name: 'Tee', row_index: 'old-row', attributes: { Colour: 'Red' }, dimensions: { received_type: 'Accepted' },
			values: { S: { qty: 2, rate: 7, name: 'saved-S' }, M: { qty: 0, name: 'saved-M' },
				L: { qty: 0, is_prefilled: 1 }, XL: { qty: 0 }, XXL: null },
		}] }]);
		vm.runInContext('addSplit(0, 0)', context);
		const rows = exposed.get_items()[0].items;
		assert.equal(rows.length, 2);
		assert.equal(rows[0].values.S.qty, 2);
		assert.equal(rows[1].name, 'Tee');
		assert.equal(rows[1].attributes.Colour, 'Red');
		assert.equal(rows[1].dimensions.received_type, 'Accepted');
		assert.equal(rows[1].row_index, undefined);
		for (const size of ['S', 'M', 'L']) {
			assert.equal(rows[1].values[size].qty, 0);
			assert.equal(rows[1].values[size].is_prefilled, 1);
			assert.equal(rows[1].values[size].name, undefined);
		}
		assert.equal(rows[1].values.XL, null);
		assert.equal(rows[1].values.XXL, null);
		rows[1].attributes.Colour = 'Blue';
		assert.equal(rows[0].attributes.Colour, 'Red');
		vm.runInContext('removeAll()', context);
		assert.equal(exposed.get_items().length, 0);
	});
}

test('Q3 MGK renders actual attribute columns and keeps YRP picker with zero GRN validation off', () => {
	const source = readFileSync(resolve(editorDirectory, 'ItemEditor.vue'), 'utf8');
	assert.match(source, /<AttributeColumns/);
	assert.match(source, /:validate-qty="props.mode !== 'grn_job'"/);
	const grid = readFileSync(resolve(editorDirectory, 'AttributeColumns.vue'), 'utf8');
	assert.match(grid, /<select/);
	assert.match(grid, /v-for="attribute in nonPrimaryAttributes\(group\)"/);
	assert.match(grid, /group.primary_attribute_values/);
	assert.match(grid, /Item Attribute/);
});

test('Q3 attribute dropdowns load Item Attribute values and save each line independently', async () => {
	const environment = desk();
	const calls = [];
	environment.frappe.db = { get_doc: async (doctype, name) => {
		calls.push([doctype, name]);
		return { item_attribute_values: [{ attribute_value: 'Red' }, { attribute_value: 'Blue' }] };
	} };
	environment.frappe.yrp = { attribute_value: value => value };
	const items = [{ attributes: ['Colour', 'Size', 'Shade'], primary_attribute: 'Size', primary_attribute_values: ['S', 'M'],
		items: [0, 1].map(() => ({ name: 'Tee', attributes: { Colour: 'Red', Shade: 'Light' },
			values: { S: { qty: 0, is_prefilled: 1 }, M: null } })) }];
	const { context, watches, events } = attributeGrid(environment, items);
	await watches[0].callback(watches[0].getter());
	await watches[0].callback(watches[0].getter());
	assert.deepEqual(calls, [['Item Attribute', 'Colour'], ['Item Attribute', 'Shade']]);
	assert.deepEqual(Array.from(vm.runInContext('nonPrimaryAttributes(props.items[0])', context)), ['Colour', 'Shade']);
	vm.runInContext("setAttribute(props.items[0].items[1], 'Colour', 'Blue')", context);
	assert.equal(items[0].items[0].attributes.Colour, 'Red');
	assert.equal(items[0].items[1].attributes.Colour, 'Blue');
	assert.equal(items[0].items[1].values.M, null);
	assert.equal(events.at(-1)[0], 'changed');
	assert.deepEqual(Array.from(vm.runInContext("attributeValues(props.items[0].items[1], 'Colour')", context)), ['Blue', 'Red']);
});

test('Q3 editing padded sizes keeps untouched cells null, takes UOM from item and preserves links', () => {
	const environment = desk();
	const items = [{ primary_attribute_values: ['S', 'M', 'L'], items: [{ name: 'Tee',
		default_uom: 'Kg', values: { S: { qty: 0, is_prefilled: 1, name: 'saved', uom: 'Kg' }, M: null, L: null } }] }];
	const { context } = attributeGrid(environment, items);
	vm.runInContext("setQuantity(props.items[0].items[0], 'M', '')", context);
	assert.equal(items[0].items[0].values.M, null);
	vm.runInContext("setQuantity(props.items[0].items[0], 'M', '3')", context);
	vm.runInContext("setRate(props.items[0].items[0], 'M', '7')", context);
	assert.equal(items[0].items[0].values.M.qty, 3);
	assert.equal(items[0].items[0].values.M.rate, 7);
	assert.equal(items[0].items[0].values.M.is_prefilled, 1);
	assert.equal(items[0].items[0].values.L, null);
	assert.equal(items[0].items[0].values.S.name, 'saved');
	assert.equal(items[0].items[0].default_uom, 'Kg');
	vm.runInContext("setQuantity(props.items[0].items[0], 'S', '-1')", context);
	assert.equal(items[0].items[0].values.S.qty, 0);
});

test('Q3 grid supports dimension editing, row deletion and bulk removal', async () => {
	const environment = desk();
	environment.frappe.call = async () => ({ message: [{ fieldname: 'received_type', label: 'Received Type', options: 'YRP Received Type' }] });
	environment.frappe.db = { get_list: async (doctype, args) => {
		assert.equal(doctype, 'YRP Received Type');
		assert.equal(args.limit, 0);
		return [{ name: 'Accepted' }, { name: 'Rejected' }];
	} };
	const items = [{ items: [0, 1, 2].map(() => ({ dimensions: { received_type: 'Accepted' }, values: {} })) }];
	const { context } = attributeGrid(environment, items);
	await environment.gridMounted();
	vm.runInContext("setDimension(props.items[0].items[1], 'received_type', 'Rejected')", context);
	assert.equal(items[0].items[1].dimensions.received_type, 'Rejected');
	vm.runInContext('selectRow(0, 0, true); selectRow(0, 2, true); removeSelected()', context);
	assert.equal(items[0].items.length, 1);
	assert.equal(items[0].items[0].dimensions.received_type, 'Rejected');
	vm.runInContext('removeRow(0, 0)', context);
	assert.equal(items[0].items.length, 0);
});

test('MGK Vue editor and grid compile with the installed Desk Vue compiler', () => {
	const compiler = require('../../../frappe/node_modules/@vue/compiler-sfc');
	for (const filename of ['ItemEditor.vue', 'AttributeColumns.vue']) {
		const source = readFileSync(resolve(editorDirectory, filename), 'utf8');
		const { descriptor, errors } = compiler.parse(source, { filename });
		assert.deepEqual(errors, []);
		const script = compiler.compileScript(descriptor, { id: filename });
		const compiled = compiler.compileTemplate({ source: descriptor.template.content, filename,
			id: filename, compilerOptions: { bindingMetadata: script.bindings } });
		assert.deepEqual(compiled.errors, []);
	}
});

test('Q3 renders dropdowns, size columns and formatted amounts in the real Vue runtime', async () => {
	const compiler = require('../../../frappe/node_modules/@vue/compiler-sfc');
	const Vue = require('../../../frappe/node_modules/vue');
	const { renderToString } = require('../../../frappe/node_modules/@vue/server-renderer');
	const source = readFileSync(resolve(editorDirectory, 'AttributeColumns.vue'), 'utf8');
	const { descriptor } = compiler.parse(source, { filename: 'AttributeColumns.vue' });
	const compiled = compiler.compileScript(descriptor, { id: 'mgk-grid', inlineTemplate: true }).content;
	const context = vm.createContext({ Vue, format_currency: value => `₹${Number(value).toFixed(2)}`,
		frappe: { db: { get_doc: async () => ({ item_attribute_values: [] }) } } });
	vm.runInContext(compiled.replace(/import\s+{([^}]+)}\s+from\s+['"]vue['"];?/g,
		(_, bindings) => `const {${bindings.replace(/\bas\b/g, ':')}} = Vue;`)
		.replace('export default', 'globalThis.component ='), context);
	const app = Vue.createSSRApp(context.component, { edit: true, mode: 'grn_job', items: [{
		attributes: ['Colour', 'Shade'], primary_attribute: 'Size', primary_attribute_values: ['S', 'M'],
		items: [{ name: 'Tee', attributes: { Colour: 'Red', Shade: 'Light' }, default_uom: 'Kg',
			values: { S: { qty: 2, rate: 7, amount: 14 }, M: null } }],
	}] });
	app.config.globalProperties.__ = value => value;
	app.config.warnHandler = warning => assert.fail(warning);
	const html = await renderToString(app);
	assert.match(html, /<select[^>]+aria-label="Colour"/);
	assert.match(html, /<select[^>]+aria-label="Shade"/);
	assert.match(html, /<th>S<\/th><th>M<\/th>/);
	assert.match(html, /₹14.00/);
});

test('J11 plan popup loads plan mode, saves empty payload, reloads and unmounts without routing', async () => {
	const environment = desk();
	const dialogs = dialogHarness(environment);
	const requests = [];
	environment.frappe.call = async args => {
		requests.push(args);
		return { message: args.method.endsWith('get_process_plan') ? [] : null };
	};
	environment.frappe.set_route = () => assert.fail('plan stays in popup');
	let reloads = 0;
	await environment.frappe.mgk_yrp.open_plan_dialog({ doc: { name: 'DC-1' }, reload_doc: async () => reloads++ });
	const dialog = dialogs[0];
	assert.equal(dialog.size, 'extra-large');
	assert.equal(dialog.visible, true);
	assert.equal(requests[0].method, 'mgk_yrp.job_work.process_plan.get_process_plan');
	assert.equal(requests[0].args.delivery_challan, 'DC-1');
	await dialog.primary_action();
	assert.equal(requests[1].method, 'mgk_yrp.job_work.process_plan.save_process_plan');
	assert.equal(requests[1].args.item_details, '[]');
	assert.equal(reloads, 1);
	assert.equal(dialog.visible, false);
});

for (const warehouses of [['WH-1'], ['WH-1', 'WH-1'], ['WH-1', 'WH-2']]) {
	test(`J19 dispatch fields, forced move, result links and refresh: ${warehouses}`, async () => {
		const environment = desk();
		const dialogs = dialogHarness(environment);
		let request, message, refreshes = 0;
		environment.frappe.call = async args => { request = args; return { message: {
			delivery_challan: 'DC-new', stock_entries: ['SE-1', 'SE-2'],
		} }; };
		environment.frappe.utils.get_form_link = (doctype, name) => `<a>${doctype}/${name}</a>`;
		environment.frappe.msgprint = value => { message = value; };
		await environment.frappe.mgk_yrp.open_dispatch_dialog(['GRN-1', 'GRN-2'], warehouses,
			() => { refreshes++; });
		const dialog = dialogs[0];
		const fields = Object.fromEntries(dialog.fields.map(field => [field.fieldname, field]));
		assert.equal(fields.process_name.options, 'YRP Process');
		assert.equal(fields.process_name.reqd, 1);
		assert.equal(fields.supplier.options, 'Supplier');
		assert.equal(fields.supplier.reqd, 1);
		assert.deepEqual(JSON.parse(JSON.stringify(fields.supplier.get_query().filters)), { is_company_location: 0, disabled: 0 });
		const forced = new Set(warehouses).size > 1;
		assert.equal(Boolean(fields.move_to_head_office.default), forced);
		assert.equal(Boolean(fields.move_to_head_office.read_only), forced);
		await dialog.primary_action({ process_name: 'Dyeing', supplier: 'Supplier', move_to_head_office: 0 });
		assert.equal(request.method, 'mgk_yrp.job_work.dc_from_grn.make_delivery_challan_from_grns');
		assert.equal(Boolean(request.args.move_to_head_office), forced);
		assert.equal(request.args.process_name, 'Dyeing');
		assert.match(JSON.stringify(message), /MGK Delivery Challan\/DC-new/);
		assert.match(JSON.stringify(message), /YRP Stock Entry\/SE-1/);
		assert.match(JSON.stringify(message), /YRP Stock Entry\/SE-2/);
		assert.equal(refreshes, 1);
	});
}

test('J19 GRN form and list open shared dispatch dialog and refresh', async () => {
	const { environment, form } = refreshForm('MGK Goods Received Note',
		{ name: 'GRN-1', docstatus: 1, warehouse: 'WH-1' }, undefined, false);
	let action, args;
	form.add_custom_button = (label, handler) => { if (label === 'Create DC') action = handler; };
	form.reload_doc = () => 'reloaded';
	environment.frappe.mgk_yrp.open_dispatch_dialog = (...values) => { args = values; };
	environment.events[form.doctype].refresh(form);
	action();
	assert.deepEqual(Array.from(args[0]), ['GRN-1']);
	assert.deepEqual(Array.from(args[1]), ['WH-1']);
	assert.equal(args[2](), 'reloaded');
	load(environment, form.doctype, '_list');
	const listview = { get_fields: () => [], page: { add_actions_menu_item(label, handler) { action = handler; } },
		get_checked_items: () => [{ name: 'GRN-1', warehouse: 'WH-1' }, { name: 'GRN-2', warehouse: 'WH-2' }],
		refresh: () => 'refreshed' };
	environment.frappe.listview_settings[form.doctype].onload(listview);
	action();
	assert.deepEqual(Array.from(args[0]), ['GRN-1', 'GRN-2']);
	assert.deepEqual(Array.from(args[1]), ['WH-1', 'WH-2']);
	assert.equal(args[2](), 'refreshed');
});

for (const doc of [{ docstatus: 0 }, { docstatus: 2 }, { docstatus: 1, is_internal_transfer: 1 }]) {
	test(`J19 dispatch hidden for ${JSON.stringify(doc)}`, () => {
		assert.ok(!buttons('MGK Goods Received Note', doc).includes('Create DC'));
	});
}

test('J19 PO receipts can dispatch; create permission is required', () => {
	assert.ok(buttons('MGK Goods Received Note', { docstatus: 1, against_purchase_order: 1 }).includes('Create DC'));
	assert.ok(!buttons('MGK Goods Received Note', { docstatus: 1 }, { 'MGK Delivery Challan': false }).includes('Create DC'));
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
