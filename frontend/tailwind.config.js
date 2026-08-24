/**
 * Tailwind maps the CSS custom properties from `src/styles/globals.css` onto
 * theme values, so a component never hardcodes a hex, a radius or a duration,
 * and both themes come for free.
 *
 * `darkMode: 'class'` is kept, but the App only toggles the `dark` class and
 * sets `data-theme`; the tokens themselves switch via `data-theme` /
 * `prefers-color-scheme`, so most components need no `dark:` variants at all.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
          // Floating layers: menus, popovers, dialogs.
          3: 'var(--surface-3)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        text: {
          DEFAULT: 'var(--text)',
          2: 'var(--text-2)',
          3: 'var(--text-3)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          weak: 'var(--accent-weak)',
          line: 'var(--accent-line)',
          fg: 'var(--on-accent)',
        },
        // Each semantic colour has a tinted background for badges and banners,
        // so state never has to be conveyed by the text colour alone.
        ok: { DEFAULT: 'var(--ok)', weak: 'var(--ok-weak)' },
        warn: { DEFAULT: 'var(--warn)', weak: 'var(--warn-weak)' },
        danger: { DEFAULT: 'var(--danger)', weak: 'var(--danger-weak)' },
        info: { DEFAULT: 'var(--info)', weak: 'var(--info-weak)' },
      },
      fontFamily: {
        sans: 'var(--font-ui)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        // 13.5px base; the smaller steps are for column headers and badges.
        '2xs': ['10.5px', '14px'],
        xs: ['11.5px', '16px'],
        sm: ['12.5px', '17px'],
        base: ['13.5px', '19px'],
        md: ['14.5px', '21px'],
        lg: ['16.5px', '23px'],
        xl: ['19px', '25px'],
        '2xl': ['23px', '29px'],
      },
      letterSpacing: {
        // Large text needs negative tracking to stop looking loose.
        tight: '-0.011em',
        tighter: '-0.022em',
        wide: '0.04em',
        wider: '0.09em',
      },
      spacing: {
        row: 'var(--row-h)',
        toolbar: 'var(--toolbar-h)',
        statusbar: 'var(--statusbar-h)',
      },
      height: {
        row: 'var(--row-h)',
        toolbar: 'var(--toolbar-h)',
        statusbar: 'var(--statusbar-h)',
      },
      minHeight: {
        row: 'var(--row-h)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        // Paired with an inset highlight so dark surfaces get a lit top edge
        // instead of reading as flat cut-outs.
        e1: 'var(--elev-1), inset 0 1px 0 0 var(--highlight)',
        e2: 'var(--elev-2), inset 0 1px 0 0 var(--highlight)',
        e3: 'var(--elev-3), inset 0 1px 0 0 var(--highlight)',
        // A focus halo for controls that cannot use `outline`.
        focus: '0 0 0 3px var(--accent-weak), 0 0 0 1px var(--accent)',
      },
      transitionDuration: {
        DEFAULT: 'var(--dur-fast)',
        fast: 'var(--dur-fast)',
        base: 'var(--dur)',
        slow: 'var(--dur-slow)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease)',
        out: 'var(--ease)',
      },
      keyframes: {
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'dialog-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'menu-in': {
          from: { opacity: '0', transform: 'translateY(-4px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
        // A slow sheen for progress bars, so an active transfer reads as live.
        sheen: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'toast-in': 'toast-in var(--dur) var(--ease)',
        'overlay-in': 'overlay-in var(--dur-fast) var(--ease)',
        'dialog-in': 'dialog-in var(--dur) var(--ease)',
        'menu-in': 'menu-in var(--dur-fast) var(--ease)',
        spin: 'spin 700ms linear infinite',
        indeterminate: 'indeterminate 1.2s ease-in-out infinite',
        sheen: 'sheen 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
