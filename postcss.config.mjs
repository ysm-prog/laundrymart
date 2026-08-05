// Tailwind v4 ships its PostCSS plugin separately and handles vendor prefixing
// itself, so autoprefixer is no longer part of the chain.
const config = { plugins: { "@tailwindcss/postcss": {} } };

export default config;
