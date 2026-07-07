# riderlens.app — share page

Static site for the domain every watermark/QR points to. No build step.

## Deploy (Cloudflare Pages)

Dashboard → Workers & Pages → Create → Pages → **Upload assets** → drag this
`site/` folder → name the project `riderlens` → deploy. Then Custom domains →
add `riderlens.app` (domain is already on Cloudflare, so DNS is one click).

Or connect the GitHub repo and set the build output directory to `site/`.

## Pages

- `index.html` — pitch + beta CTA (swap the mailto for store badges at launch)
- `privacy.html` / `terms.html` — required for TestFlight external testing and
  App Store review. Drafts — review before public launch.

## Email

Cloudflare → Email → Email Routing: forward `hello@riderlens.app` to your
inbox (free). It's the contact on all three pages.
