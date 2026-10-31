# mgk_yrp agent rules

## UI rules

- All user-facing dates must be DD-MM-YYYY (datetimes DD-MM-YYYY HH:mm). Use the shared formatter `frontend/src/shared/formatDate.js` (`formatDate`, `formatDatetime`) and `frontend/src/shared/DateInput.vue` for date inputs (PrimeVue DatePicker with `date-format="dd-mm-yy"`); never render raw ISO dates. Server payloads stay ISO YYYY-MM-DD (`toIsoDate`). In Desk JS use `frappe.datetime.str_to_user`.

## Build and test

- /web frontend: `cd frontend && yarn test && yarn build`.
- Desk assets: from `../../sites` run `../env/bin/python -m frappe.utils.bench_helper frappe build --app mgk_yrp`.
