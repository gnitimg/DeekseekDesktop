/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: '#0d0d0f', panel: '#161618', hover: '#1f1f23', border: '#2a2a2e' },
        accent: { DEFAULT: '#4f46e5', hover: '#6366f1' }
      }
    }
  },
  plugins: []
}
