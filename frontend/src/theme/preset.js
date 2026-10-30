import { definePreset } from "@primeuix/themes"
import Aura from "@primeuix/themes/aura"

const preset = definePreset(Aura, {
	semantic: {
		primary: {
			50: "var(--primary-50)",
			100: "var(--primary-100)",
			200: "var(--primary-200)",
			300: "var(--primary-300)",
			400: "var(--primary-400)",
			500: "var(--primary-500)",
			600: "var(--primary-600)",
			700: "var(--primary-700)",
			800: "var(--primary-800)",
			900: "var(--color-primary)",
			950: "var(--color-text)",
		},
		focusRing: { width: "3px", style: "solid", color: "var(--color-accent)", offset: "2px" },
		formField: { background: "var(--color-card)", color: "var(--color-text)" },
		content: { background: "var(--color-card)", color: "var(--color-text)" },
		overlay: {
			select: { background: "var(--color-card)", color: "var(--color-text)" },
			popover: { background: "var(--color-card)", color: "var(--color-text)" },
			modal: { background: "var(--color-card)", color: "var(--color-text)" },
		},
		list: { option: { color: "var(--color-text)", focusBackground: "var(--color-table-head)" } },
		colorScheme: {
			light: {
				primary: {
					color: "var(--color-primary)",
					inverseColor: "var(--color-card)",
					hoverColor: "var(--color-primary-hover)",
					activeColor: "var(--color-text)",
				},
				highlight: {
					background: "var(--color-info-bg)", focusBackground: "var(--primary-100)",
					color: "var(--color-accent)", focusColor: "var(--color-primary)",
				},
				surface: {
					0: "var(--color-card)", 50: "var(--color-page)", 100: "var(--color-table-head)",
					200: "var(--color-line)", 300: "var(--surface-300)", 400: "var(--surface-400)",
					500: "var(--surface-500)", 600: "var(--color-muted)", 700: "var(--surface-700)",
					800: "var(--color-primary-hover)", 900: "var(--color-primary)", 950: "var(--color-text)",
				},
			},
		},
	},
	components: {
		button: {
			root: { borderRadius: "var(--radius-sm)" },
			paddingX: "0.85rem", paddingY: "0.5rem",
			sm: { paddingX: "0.7rem", paddingY: "0.4rem", fontSize: "0.8125rem" },
			label: { fontWeight: "700" },
			focusRing: { width: "3px", style: "solid", color: "var(--color-accent)", offset: "2px" },
		},
		datatable: {
			headerCell: {
				padding: "12px 14px", background: "var(--color-table-head)", color: "var(--color-muted)",
				borderColor: "var(--color-line)", fontWeight: "800",
			},
			bodyCell: { padding: "14px", borderColor: "var(--color-line)" },
			row: { hoverBackground: "var(--color-row-hover)" },
		},
		inputtext: {
			borderRadius: "var(--radius-sm)", paddingX: "0.7rem", paddingY: "0.5rem",
			background: "var(--color-card)", color: "var(--color-text)",
			borderColor: "var(--color-line)", focusBorderColor: "var(--color-accent)",
		},
		select: {
			borderRadius: "var(--radius-sm)", background: "var(--color-card)", color: "var(--color-text)",
			borderColor: "var(--color-line)", focusBorderColor: "var(--color-accent)",
			overlay: { background: "var(--color-card)", color: "var(--color-text)", borderColor: "var(--color-line)" },
			option: { color: "var(--color-text)", focusBackground: "var(--color-table-head)" },
		},
		datepicker: {
			borderRadius: "var(--radius-sm)",
			panel: { background: "var(--color-card)", borderColor: "var(--color-line)" },
		},
		inputnumber: { borderRadius: "var(--radius-sm)" },
		textarea: {
			borderRadius: "var(--radius-sm)", background: "var(--color-card)", color: "var(--color-text)",
			borderColor: "var(--color-line)", focusBorderColor: "var(--color-accent)",
		},
		autocomplete: {
			overlay: { background: "var(--color-card)", color: "var(--color-text)", borderColor: "var(--color-line)" },
			option: { color: "var(--color-text)", focusBackground: "var(--color-table-head)" },
		},
		multiselect: {
			background: "var(--color-card)", borderColor: "var(--color-line)",
			overlay: { background: "var(--color-card)", color: "var(--color-text)", borderColor: "var(--color-line)" },
		},
		menu: { background: "var(--color-card)", color: "var(--color-text)", borderColor: "var(--color-line)" },
		popover: { background: "var(--color-card)", color: "var(--color-text)", borderColor: "var(--color-line)" },
		toggleswitch: { checkedBackground: "{primary.color}", checkedHoverBackground: "{primary.hoverColor}", background: "{surface.300}" },
		tabs: {
			tab: { fontWeight: "500", activeColor: "{primary.color}", color: "var(--color-muted)", padding: "0.6rem 0.9rem" },
			activeBar: { height: "2px", background: "{primary.color}" },
		},
		tag: {
			fontWeight: "600", padding: "0.2rem 0.55rem", borderRadius: "999px",
			primary: { background: "var(--color-info-bg)", color: "var(--color-accent)" },
			info: { background: "var(--color-info-bg)", color: "var(--color-accent)" },
			success: { background: "var(--color-live-bg)", color: "var(--color-live)" },
			warn: { background: "var(--color-warning-bg)", color: "var(--color-warning)" },
			danger: { background: "var(--color-danger-bg)", color: "var(--color-danger)" },
			secondary: { background: "var(--color-count)", color: "var(--color-muted)" },
		},
		dialog: { borderRadius: "var(--radius)", headerPadding: "1rem 1.25rem", contentPadding: "0 1.25rem 1.25rem" },
		card: {
			root: { background: "var(--color-card)", color: "var(--color-text)", borderRadius: "var(--radius)" },
			body: { padding: "0" },
		},
		paginator: { padding: "0.5rem 0.75rem" },
	},
})

export default preset
