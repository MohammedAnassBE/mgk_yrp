const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const childType = "MGK Item Process Conversion";
const table = "mgk_process_conversions";

function desk() {
	const events = {};
	const queries = [];
	const requests = [];
	const rows = [{ doctype: childType, name: "row-1", from_qty: 0 }];
	const locals = { [childType]: { "row-1": rows[0] } };
	const frappe = {
		ui: { form: { on: (doctype, handlers) => { events[doctype] = handlers; } } },
		model: {
			async set_value(doctype, name, field, value) {
				Object.assign(locals[doctype][name], typeof field === "string" ? { [field]: value } : field);
			},
		},
		db: { get_value: async (...args) => {
			requests.push(args);
			return { message: { stock_uom: "Nos" } };
		} },
	};
	const frm = {
		doc: { name: "Yarn", stock_uom: "Kg", [table]: rows },
		set_query: (...args) => { queries.push(args); },
	};
	vm.runInContext(readFileSync(resolve(__dirname, "../public/js/item.js"), "utf8"),
		vm.createContext({ frappe, locals }));
	return { events, queries, requests, rows, locals, frappe, frm };
}

test("row add fills source UOM and defaults empty source quantity", async () => {
	const { events, frm, rows } = desk();
	await events[childType].mgk_process_conversions_add(frm, childType, "row-1");
	assert.equal(rows[0].from_uom, "Kg");
	assert.equal(rows[0].from_qty, 1);
	rows[0].from_qty = 3;
	await events[childType].mgk_process_conversions_add(frm, childType, "row-1");
	assert.equal(rows[0].from_qty, 3);
});

test("item change refreshes source UOM and fetches output stock UOM", async () => {
	const { events, frm, rows, requests } = desk();
	Object.assign(rows[0], { item: "Doubled Yarn", from_uom: "Bag", from_qty: 3 });
	await events[childType].item(frm, childType, "row-1");
	assert.equal(rows[0].from_uom, "Kg");
	assert.equal(rows[0].to_uom, "Nos");
	assert.equal(rows[0].from_qty, 3);
	assert.deepEqual(requests, [["Item", "Doubled Yarn", "stock_uom"]]);
});

test("stock UOM change refreshes every row and preserves quantities and output UOM", async () => {
	const { events, frm, rows, locals } = desk();
	Object.assign(rows[0], { from_qty: 3, to_qty: 5, to_uom: "Nos" });
	const second = { doctype: childType, name: "row-2", from_qty: 4, to_qty: 6, to_uom: "Kg" };
	rows.push(second);
	locals[childType][second.name] = second;
	frm.doc.stock_uom = "Bag";
	await events.Item.stock_uom(frm);
	assert.deepEqual(rows.map(row => row.from_uom), ["Bag", "Bag"]);
	assert.deepEqual(rows.map(row => row.from_qty), [3, 4]);
	assert.deepEqual(rows.map(row => row.to_qty), [5, 6]);
	assert.deepEqual(rows.map(row => row.to_uom), ["Nos", "Kg"]);
});

test("clearing output item clears output UOM without a lookup", async () => {
	const { events, frm, rows, requests } = desk();
	Object.assign(rows[0], { item: "", to_uom: "Nos" });
	await events[childType].item(frm, childType, "row-1");
	assert.equal(rows[0].to_uom, null);
	assert.equal(rows[0].from_uom, "Kg");
	assert.equal(requests.length, 0);
});

test("late output UOM response cannot restore a cleared item", async () => {
	const { events, frm, rows, frappe } = desk();
	let finish;
	frappe.db.get_value = () => new Promise(resolve => { finish = resolve; });
	rows[0].item = "Doubled Yarn";
	const pending = events[childType].item(frm, childType, "row-1");
	await Promise.resolve();
	rows[0].item = "";
	await events[childType].item(frm, childType, "row-1");
	finish({ message: { stock_uom: "Nos" } });
	await pending;
	assert.equal(rows[0].to_uom, null);
});

test("conversion output query allows the current Item", () => {
	const { events, frm, queries } = desk();
	events.Item.setup?.(frm);
	assert.equal(queries.length, 0);
});

test("stock UOM handler accepts an Item without conversion rows", async () => {
	const { events, frm } = desk();
	delete frm.doc[table];
	await events.Item.stock_uom(frm);
});

test("fixtures place conversion fields after variant attributes and show them only on templates", () => {
	const fixtures = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/custom_field.json"), "utf8"));
	const section = fixtures.find(field => field.name === "Item-mgk_process_conversion_section");
	const conversions = fixtures.find(field => field.name === "Item-mgk_process_conversions");
	assert.ok(section);
	assert.ok(conversions);
	for (const field of [section, conversions]) {
		assert.equal(field.doctype, "Custom Field");
		assert.equal(field.dt, "Item");
		assert.equal(field.module, "MGK YRP");
		assert.equal(field.depends_on, "eval:doc.has_variants");
	}
	assert.equal(section.fieldtype, "Section Break");
	assert.equal(section.label, "");
	assert.equal(conversions.label, "Process Conversions");
	assert.equal(section.insert_after, "variants_section");
	assert.equal(conversions.fieldtype, "Table");
	assert.equal(conversions.options, childType);
	assert.equal(conversions.insert_after, section.fieldname);
	assert.equal(fixtures.indexOf(conversions), fixtures.indexOf(section) + 1);
});

test("conversion fields cannot be copied to variants", () => {
	const fixtures = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/custom_field.json"), "utf8"));
	for (const name of ["Item-mgk_process_conversion_section", "Item-mgk_process_conversions"]) {
		assert.equal(fixtures.find(field => field.name === name).no_copy, 1);
	}
});

test("child schema declares ordered conversion fields and output UOM fetch", () => {
	const directory = "../mgk_yrp/doctype/mgk_item_process_conversion";
	const schema = JSON.parse(readFileSync(resolve(__dirname, directory, "mgk_item_process_conversion.json"), "utf8"));
	assert.equal(schema.module, "MGK YRP");
	assert.equal(schema.istable, 1);
	assert.equal(schema.editable_grid, 1);
	assert.deepEqual(schema.field_order, ["process_name", "item", "from_uom", "from_qty", "to_uom", "to_qty"]);
	assert.deepEqual(schema.fields.map(field => field.fieldname), schema.field_order);
	assert.ok(schema.fields.every(field => field.in_list_view === 1));
	assert.equal(schema.fields.find(field => field.fieldname === "to_uom").fetch_from, "item.stock_uom");
});
