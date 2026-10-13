/** @type {import('tailwindcss').Config} */

// All semantic colours are CSS-variable channels ("R G B"), consumed as
// rgb(var(--token) / <alpha-value>) so that:
//   1. Tailwind opacity modifiers keep working (bg-avaira-card/80,
//      border-avaira-primary/30, ...), and
//   2. one class scope can re-theme the whole tree — `.theme-marketing`
//      (light) vs the default dark console. See src/index.css.
const tok = (name) => `rgb(var(${name}) / <alpha-value>)`;

module.exports = {
    darkMode: ["class"],
    content: ["./src/**/*.{js,jsx,ts,tsx}", "./public/index.html"],
    theme: {
        extend: {
            fontFamily: {
                // The console keeps JetBrains Mono for machine data; headings and
                // body share Inter, matching the reference marketing design.
                heading: ['Inter', 'system-ui', 'sans-serif'],
                mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
                body: ['Inter', 'system-ui', 'sans-serif'],
            },
            colors: {
                avaira: {
                    bg: tok('--surface-app'),
                    card: tok('--surface-card'),
                    surface: tok('--surface-raised'),
                    inset: tok('--surface-inset'),
                    primary: tok('--accent'),
                    primaryHover: tok('--accent-hover'),
                    red: tok('--danger'),
                    purple: tok('--violet'),
                    green: tok('--success'),
                    yellow: tok('--warning'),
                    redAlert: tok('--danger'),
                    danger: tok('--danger'),
                    redLegacy: tok('--danger'),
                    border: tok('--hairline'),
                    borderStrong: tok('--hairline-strong'),
                    muted: tok('--text-secondary'),
                    dim: tok('--text-muted'),
                    data: tok('--info'),
                },
                background: tok('--background'),
                foreground: tok('--foreground'),
                card: { DEFAULT: tok('--card'), foreground: tok('--card-foreground') },
                popover: { DEFAULT: tok('--popover'), foreground: tok('--popover-foreground') },
                primary: { DEFAULT: tok('--primary'), foreground: tok('--primary-foreground') },
                secondary: { DEFAULT: tok('--secondary'), foreground: tok('--secondary-foreground') },
                muted: { DEFAULT: tok('--muted'), foreground: tok('--muted-foreground') },
                accent: { DEFAULT: tok('--accent-ui'), foreground: tok('--accent-ui-foreground') },
                destructive: { DEFAULT: tok('--destructive'), foreground: tok('--destructive-foreground') },
                border: tok('--border-ui'),
                input: tok('--input'),
                ring: tok('--ring'),
                chart: {
                    '1': tok('--chart-1'),
                    '2': tok('--chart-2'),
                    '3': tok('--chart-3'),
                    '4': tok('--chart-4'),
                    '5': tok('--chart-5'),
                },
            },
            borderRadius: {
                lg: 'var(--radius)',
                md: 'calc(var(--radius) - 2px)',
                sm: 'calc(var(--radius) - 4px)',
            },
            boxShadow: {
                // Console: barely-there elevation. Marketing: soft, layered.
                panel: 'var(--shadow-panel)',
                'panel-hover': 'var(--shadow-panel-hover)',
                mk: '0 1px 2px rgba(16,24,40,0.04), 0 12px 32px -16px rgba(16,24,40,0.18)',
                'mk-lg': '0 2px 4px rgba(16,24,40,0.04), 0 32px 64px -24px rgba(16,24,40,0.24)',
                'mk-btn': '0 1px 2px rgba(16,24,40,0.08), 0 0 0 1px rgba(16,24,40,0.04)',
            },
            keyframes: {
                'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
                'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
                'glow-pulse': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.55' } },
                'scan': { '0%': { transform: 'translateY(-100%)' }, '100%': { transform: 'translateY(100%)' } },
                'slide-in': { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
                'rise-in': { '0%': { opacity: '0', transform: 'translateY(18px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
                'floating': { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-8px)' } },
                'glitch': {
                    '0%': { transform: 'translate(0)' },
                    '20%': { transform: 'translate(-1px, 1px)' },
                    '40%': { transform: 'translate(-1px, -1px)' },
                    '60%': { transform: 'translate(1px, 1px)' },
                    '80%': { transform: 'translate(1px, -1px)' },
                    '100%': { transform: 'translate(0)' },
                },
                'hologram': { '0%, 100%': { opacity: '0.9' }, '50%': { opacity: '0.6' } },
                'marquee': { '0%': { transform: 'translateX(0)' }, '100%': { transform: 'translateX(-50%)' } },
            },
            animation: {
                'accordion-down': 'accordion-down 0.2s ease-out',
                'accordion-up': 'accordion-up 0.2s ease-out',
                'glow-pulse': 'glow-pulse 2.4s ease-in-out infinite',
                'scan': 'scan 5s linear infinite',
                'slide-in': 'slide-in 0.3s ease-out both',
                'rise-in': 'rise-in 0.6s cubic-bezier(0.22, 1, 0.36, 1) both',
                'floating': 'floating 4s ease-in-out infinite',
                'glitch': 'glitch 0.2s ease-in-out infinite',
                'hologram': 'hologram 2.4s ease-in-out infinite',
                'marquee': 'marquee 32s linear infinite',
            },
        },
    },
    plugins: [require("tailwindcss-animate")],
};
