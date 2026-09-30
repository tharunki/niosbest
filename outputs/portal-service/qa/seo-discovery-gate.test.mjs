import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every URL advertised to search engines needs a real page, useful metadata,
// a self-canonical, and at least one crawlable internal link from another
// public page. This prevents future SEO pages from becoming sitemap-only
// orphan pages that search engines may discover slowly or ignore.
const outputDirectory = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sitemap = await readFile(resolve(outputDirectory, 'sitemap.xml'), 'utf8');
const routes = [...sitemap.matchAll(/<loc>https:\/\/niosbest\.in([^<]*)<\/loc>/g)].map(match => match[1] || '/');
const fileForRoute = route => route === '/' ? 'index.html' : `${route.slice(1)}.html`;

assert.ok(routes.length > 0, 'sitemap must advertise public pages');
assert.equal(new Set(routes).size, routes.length, 'sitemap must not contain duplicate URLs');

const pages = new Map(await Promise.all(routes.map(async route => [
  route,
  await readFile(resolve(outputDirectory, fileForRoute(route)), 'utf8')
])));

function normalizedPublicPath(pathname) {
  return pathname === '/index.html' ? '/' : pathname.replace(/\.html$/, '');
}

function publicLinksFrom(route, html) {
  const links = [];
  for (const match of html.matchAll(/\bhref=["']([^"']+)["']/gi)) {
    const href = match[1].trim();
    if (!href || href.startsWith('#') || /^(?:mailto:|tel:|javascript:)/i.test(href)) continue;
    let parsed;
    try { parsed = new URL(href, `https://niosbest.in${route}`); }
    catch { continue; }
    if (parsed.hostname !== 'niosbest.in') continue;
    links.push(normalizedPublicPath(parsed.pathname));
  }
  return links;
}

for (const [route, html] of pages) {
  assert.match(html, /<title>[^<]{12,}<\/title>/i, `${route} needs a descriptive title`);
  assert.match(html, /<meta\s+name=["']description["']\s+content=["'][^"']{50,}["']/i, `${route} needs a useful meta description`);
  assert.match(html, /<link\s+rel=["']canonical["']\s+href=["']https:\/\/niosbest\.in\/?[^"']*["']/i, `${route} needs an apex canonical`);
}

for (const target of routes.filter(route => route !== '/')) {
  const inboundSource = [...pages].find(([source, html]) => source !== target && publicLinksFrom(source, html).includes(target))?.[0];
  assert.ok(inboundSource, `${target} must have an inbound link from another sitemap page`);
}

console.log(`seo-discovery-gate.test.mjs: ${routes.length} pages have metadata, canonicals, and inbound public links`);
