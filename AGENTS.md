# Repository Guidelines

## Project Structure & Module Organization

The parent `DEVELOPMENT_PLAN.md` records product decisions. Core UI and behavior are in `app/page.tsx`, styling is in `app/globals.css`, and metadata is defined in `app/layout.tsx`. Static assets belong in `public/`, including the PDF.js worker. Hosting configuration is stored in `.openai/hosting.json`; build tooling is configured in `vite.config.ts`, `next.config.ts`, and `eslint.config.mjs`.

Keep new editor logic close to the page component until a module has a clear independent responsibility. Extract reusable code into focused files under `app/`, such as `app/pdf/export.ts` or `app/components/PageCanvas.tsx`.

## Build, Test, and Development Commands

Run commands from this directory with Node.js 22.13 or newer.

- `npm install` installs pinned dependencies from `package-lock.json`.
- `npm run dev` starts the local Vinext development server.
- `npm run lint` checks TypeScript, React, and Next.js conventions.
- `npx tsc --noEmit` performs a standalone type check.
- `npm run build` creates the production Cloudflare-compatible output in `dist/`.
- `npm run start` serves an existing production build locally.

Before submitting changes, run all three validation commands.

## Coding Style & Naming Conventions

Use TypeScript and React functional components with two-space indentation and single-quoted strings. Use `PascalCase` for components and types, `camelCase` for functions and state, and descriptive names such as `exportJpgs` or `PageCanvas`. Keep browser-only files marked with `'use client'`. Prefer normalized page coordinates for redactions so geometry remains independent of zoom and DPI.

Do not edit or reformat `public/pdf.worker.min.mjs`; it is a vendored static asset intentionally excluded from linting.

## Testing Guidelines

No automated test framework is configured yet. Treat `npm run lint`, `npx tsc --noEmit`, and `npm run build` as the minimum gate. Manually verify PDF loading, page rotation, rectangle alignment, undo/redo, and both single-JPG and multi-page ZIP exports. Future tests should use `*.test.ts` or `*.test.tsx` naming.

## Commit & Pull Request Guidelines

The existing history uses short, imperative summaries, for example `Build Blackline PDF redaction MVP`. Keep commits focused and avoid generated output such as `dist/` or `*.tsbuildinfo`. Pull requests should explain user-visible behavior, list verification performed, link relevant issues, and include screenshots for interface changes. Call out PDF security, privacy, worker, or export changes explicitly.

## Security & Privacy

PDF bytes must remain browser-local. Never add document logging, analytics containing filenames, or remote upload behavior without an explicit product decision. Redactions must be burned into exported JPG pixels; visual overlays alone are not secure redaction.
