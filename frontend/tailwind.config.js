/**
 * Tailwind maps the CSS custom properties from `src/styles/globals.css` onto
 * theme colours, so a component never hardcodes a hex value and both themes
 * come for free.
 *
 * `darkMode: 'class'` is kept, but the App only ever toggles the `dark` class
 * and sets `data-theme`; the meaningless `light` class the old code added is
 * gone. The tokens themselves switch via `data-theme` / `prefers-color-scheme`,
 * so most components need no dark: variants at all.
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
          weak: 'var(--accent-weak)',
          fg: 'var(--on-accent)',
        },
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        danger: 'var(--danger)',
        info: 'var(--info)',
      },
      fontFamily: {
        sans: 'var(--font-ui)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        // 13px base; the smaller steps are for column headers and badges.
        '2xs': ['10px', '14px'],
        xs: ['11px', '16px'],
        sm: ['12px', '16px'],
        base: ['13px', '18px'],
        md: ['14px', '20px'],
        lg: ['16px', '22px'],
        xl: ['18px', '24px'],
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
        DEFAULT: 'var(--radius)',
      },
      transitionDuration: {
        DEFAULT: '120ms',
      },
      keyframes: {
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
      },
      animation: {
        'toast-in': 'toast-in 120ms ease-out',
        'overlay-in': 'overlay-in 120ms ease-out',
        spin: 'spin 700ms linear infinite',
        indeterminate: 'indeterminate 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
