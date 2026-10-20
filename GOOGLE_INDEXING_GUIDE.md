# Getting Google to index your site

This system already ships with everything Google needs — you just need to plug
in your real domain and click a few buttons in Google Search Console. This
takes about 15 minutes and doesn't require touching any code.

## What's already set up for you

- **`frontend/robots.txt`** — tells search engines which pages are safe to
  index (the marketing pages: `index.html`, `pricing.html`, `demo.html`,
  `terms.html`, `privacy.html`, `refund-policy.html`) and which to skip
  (`login.html`, `signup.html`, `dashboard.html`, `super-admin.html`,
  `install.html`, `reset-password.html` — private/functional screens with
  nothing useful to show a search engine).
- **`frontend/sitemap.xml`** — a list of the public pages, referenced from the
  bottom of `robots.txt`.
- **Title + description + Open Graph tags** on `index.html`, `pricing.html`,
  and `demo.html` — this is what shows up as the blue link and grey snippet
  in Google search results, and what shows up when the link is shared on
  WhatsApp/Facebook/Twitter.
- **`<meta name="robots" content="noindex, nofollow">`** on every private
  page, as a second layer of protection even if something ever links to them
  directly.

## Step 1 — Replace the placeholder domain (required)

Every file above currently says `https://YOUR-DOMAIN-HERE.com`. Open these
three files and replace that placeholder with wherever this is actually
hosted (e.g. `https://www.okvtechnology.com`):

1. `frontend/robots.txt` — one line at the bottom (`Sitemap:`)
2. `frontend/sitemap.xml` — six `<loc>` lines
3. `frontend/pricing.html`, `frontend/index.html`, `frontend/demo.html` —
   the `<link rel="canonical">` and `<meta property="og:url">` lines each

A quick way to do this in one pass: search-and-replace
`YOUR-DOMAIN-HERE.com` → your real domain across the `frontend/` folder in
whatever editor or hosting tool you use to deploy these files.

## Step 2 — Verify ownership in Google Search Console

1. Go to [Google Search Console](https://search.google.com/search-console)
   and sign in with the Google account you want managing this.
2. Click **Add property** → **URL prefix** → enter your homepage URL (e.g.
   `https://www.okvtechnology.com/index.html`).
3. Google will offer a few verification methods. The easiest with a static
   site like this one is **HTML file upload**: Google gives you a file named
   something like `google1234567890abcdef.html` — download it, drop it into
   the same `frontend/` folder as `index.html` (so it deploys alongside
   everything else), then click **Verify** in Search Console.
   - Alternative: the **HTML tag** method instead gives you a single
     `<meta name="google-site-verification" content="...">` tag to paste
     into the `<head>` of `index.html`, right under the other `<meta>` tags.
     Either method works — pick whichever is easier with your hosting setup.

## Step 3 — Submit your sitemap

Once verified:

1. In Search Console, open **Sitemaps** in the left sidebar.
2. Enter `sitemap.xml` in the box and click **Submit**.
3. Google will crawl it over the next few days. You can check progress under
   **Pages** in the left sidebar — it'll show how many pages are indexed vs.
   excluded (private pages showing as "excluded by robots.txt" is expected
   and correct).

## Step 4 — (Optional but recommended) Request individual pages be indexed sooner

Indexing via sitemap alone can take days to weeks. To speed it up for your
homepage:

1. In Search Console, paste your homepage URL into the search bar at the top.
2. Click **Request Indexing**.
3. Repeat for `pricing.html` if you want it prioritized too.

## Keeping this current

- If you add new public marketing pages later, add them to both
  `sitemap.xml` (with a `<loc>`, `<lastmod>`, `<changefreq>`, `<priority>`)
  and as an `Allow:` line in `robots.txt`.
- Update the `<lastmod>` dates in `sitemap.xml` whenever you meaningfully
  update a page's content — it's a hint to Google about how often to
  re-crawl, not a hard requirement.
- Never remove the `Disallow:` lines for `dashboard.html`/`super-admin.html`/
  `login.html`/etc. — those pages have no content of value to a search
  engine and indexing them would only expose your app's internal URL
  structure for no benefit.
