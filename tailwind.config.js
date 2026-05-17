/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        'sn-bg': '#0A0A0C',
        'sn-surface': '#111116',
        'sn-elevated': '#1A1A22',
        'sn-hover': '#22222E',
        'sn-text': '#F0F0F8',
        'sn-text-secondary': '#7A7A94',
        'sn-text-muted': '#3A3A50',
        'sn-border': '#1E1E2A',
        'sn-lime': '#C8F23A',
        'sn-magenta': '#F23AC8',
        'sn-cyan': '#3AC8F2',
        'sn-orange': '#F2A83A',
        'sn-purple': '#9C3AF2',
        'sn-red': '#F23A5E',
        'sn-track-1': '#C8F23A',
        'sn-track-2': '#3AC8F2',
        'sn-track-3': '#F2A83A',
        'sn-track-4': '#F23AC8',
      },
      fontFamily: {
        display: ['"Barlow Condensed"', 'Oswald', 'Impact', 'sans-serif'],
        ui: ['Sora', '"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        'sn-sm': '4px',
        'sn-md': '8px',
        'sn-lg': '16px',
        'sn-xl': '24px',
      },
      boxShadow: {
        'sn-lg': '0 24px 64px rgba(0,0,0,0.6)',
        'sn-lime': '0 0 24px rgba(200,242,58,0.35)',
        'sn-lime-soft': '0 0 12px rgba(200,242,58,0.4)',
      },
      keyframes: {
        'sn-pulse': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.01)' },
        },
        'sn-blink': {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
        'sn-spin-slow': {
          to: { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'sn-pulse': 'sn-pulse 2.4s ease-in-out infinite',
        'sn-blink': 'sn-blink 1s steps(1) infinite',
        'sn-spin-slow': 'sn-spin-slow 24s linear infinite',
      },
    },
  },
  plugins: [],
};
