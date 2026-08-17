import { defineConfig } from 'vite';

// Relative, so the bundle works at any subpath — GitHub Pages project sites
// serve from /<repo>/ — and under a custom domain without rebuilding.
export default defineConfig({ base: './' });
