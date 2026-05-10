/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        mint:   '#e5ffde',
        silver: '#bbcbcb',
        muted:  '#9590a8',
        plum:   '#634b66',
        ink:    '#18020c',
        primary: {
          DEFAULT: '#634b66',
          dark:    '#18020c',
          light:   '#9590a8'
        }
      }
    }
  },
  plugins: []
};