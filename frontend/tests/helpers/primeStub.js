import { h, ref } from "vue"
import { toIsoDate } from "../../src/shared/formatDate.js"

export const Menu = {
	props: ["model", "popup"],
	setup(props, { expose }) {
		const is_open = ref(false)
		expose({ toggle: () => { is_open.value = !is_open.value }, hide: () => { is_open.value = false } })
		return () => is_open.value ? h("div", { role: "menu" }, props.model.map((item) => h("button", {
			role: "menuitem", disabled: item.disabled, onClick: () => { is_open.value = false; return item.command() },
		}, item.label))) : null
	},
}

export const Button = {
	props: ["label", "disabled"],
	setup: (props, { attrs }) => () => h("button", { ...attrs, disabled: props.disabled }, props.label),
}
export const InputNumber = {
	props: ["modelValue", "disabled"],
	setup: (props, { attrs, emit }) => () => h("input", { ...attrs, value: props.modelValue, disabled: props.disabled,
		onInput: (event) => emit("update:modelValue", Number(event.target.value)) }),
}
export const Dialog = {
	props: ["visible"],
	setup: (props, { slots }) => () => props.visible ? h("dialog", {}, [slots.default?.(), slots.footer?.()]) : null,
}

export const Message = {
	setup: (props, { slots }) => () => h("div", {}, slots.default?.()),
}

export const InputText = {
	props: ["modelValue", "disabled"],
	setup: (props, { attrs, emit }) => () => h("input", { ...attrs, value: props.modelValue, disabled: props.disabled,
		onInput: (event) => emit("update:modelValue", event.target.value) }),
}
export const Textarea = InputText
export const DatePicker = {
	props: ["modelValue", "disabled", "inputId", "dateFormat"],
	setup: (props, { attrs, emit }) => () => h("input", { ...attrs, id: props.inputId ?? attrs.id, disabled: props.disabled,
		value: props.modelValue instanceof Date ? toIsoDate(props.modelValue) : props.modelValue, "data-date-format": props.dateFormat,
		onInput: (event) => emit("update:modelValue", event.target.value ? new Date(`${event.target.value}T00:00:00`) : null) }),
}
export const ToggleSwitch = {
	props: ["modelValue", "disabled"],
	setup: (props, { attrs, emit }) => () => h("input", { ...attrs, type: "checkbox", checked: props.modelValue, disabled: props.disabled,
		onChange: (event) => emit("update:modelValue", event.target.checked) }),
}
export const Select = {
	props: ["modelValue", "options", "disabled"],
	setup: (props, { attrs, emit }) => () => h("select", { ...attrs, value: props.modelValue, disabled: props.disabled,
		onChange: (event) => emit("update:modelValue", event.target.value) }, props.options.map((value) => h("option", { value }, value))),
}
export const MultiSelect = {
	props: ["modelValue", "options", "disabled"],
	setup: (props, { attrs, emit }) => () => h("select", { ...attrs, multiple: true, value: props.modelValue, disabled: props.disabled,
		onChange: (event) => emit("update:modelValue", event.target.values) }, props.options.map((value) => h("option", { value }, value))),
}
export const Toast = { render: () => null }
