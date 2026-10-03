# Runo website

A static introduction to Runo and its documentation, built for runo.sh. The site has no backend, tracking or external runtime dependencies. Fonts and the diagram are hosted with the site.

## Build and preview

From this directory:

```bash
bun install --frozen-lockfile
bun run build
bun run check
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open <http://localhost:4173>. `build.mjs` renders the home page and Markdown from `../docs/` into `dist/`. Update the Markdown source to change documentation on both GitHub and the site.

## Diagram and motion

The interactive workflow is rendered in HTML and CSS with finite JavaScript animations. Its static SVG counterpart is embedded in the repository README. Neither represents live infrastructure.

Motion respects `prefers-reduced-motion`. The diagram plays once when visible, can be paused or replayed, and has buttons for exploring individual steps. Content remains readable without JavaScript.

## Vercel

The repository root contains `vercel.json`, which builds this directory and publishes `website/dist`. Use the repository root when linking the Vercel project. Canonical URLs and the sitemap use `https://runo.sh`.

Deployment target: the `runo` project in the `kodustech` Vercel team, with `runo.sh` as the production domain. The project is connected to `kodustech/runo` on GitHub.

After a deployment, verify the production routes, diagram, robots and sitemap. Submit the sitemap in a verified Search Console property. Crawling eligibility does not guarantee indexing or AI citations.

Keep source links and deployed documentation in sync by publishing their repository changes together.
