import { h } from "vue"

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
export const DatePicker = InputText
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
