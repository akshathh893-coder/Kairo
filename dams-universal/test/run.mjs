/**
 * Headless test + benchmark driver.
 *
 * Usage (from a static server serving the project root):
 *   node test/run.mjs [baseUrl]
 * Defaults to http://127.0.0.1:8199
 *
 * Requires Playwright + a Chromium build. In this environment:
 *   node test/run.mjs
 * Exits non-zero if any test fails or any benchmark budget is exceeded.
 */
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://127.0.0.1:8199';

/** @type {import('playwright').LaunchOptions} */
const launchOpts = { args: ['--no-sandbox', '--js-flags=--expose-gc'] };
// Allow the caller to specify a custom Chromium binary via env (useful in CI
// or air-gapped environments); if not set, Playwright uses its own build.
if (process.env.PW_CHROME) launchOpts.executablePath = process.env.PW_CHROME;

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

// ---- Unit / protocol / integration tests ----
await page.goto(`${base}/dams-universal/test/index.html`);
await page.waitForFunction(() => window.__TEST_RESULTS__, null, { timeout: 30000 });
const t = await page.evaluate(() => window.__TEST_RESULTS__);
console.log(`\nTESTS: ${t.passed}/${t.total} passed` + (t.failed ? `  (${t.failed} FAILED)` : ''));
for (const r of t.results.filter((r) => !r.pass)) console.log('  ❌ ' + r.name + ' — ' + r.error);

// ---- Benchmarks / stress / memory ----
await page.goto(`${base}/dams-universal/test/bench.html`);
await page.waitForFunction(() => window.__BENCH_RESULTS__, null, { timeout: 60000 });
const b = await page.evaluate(() => window.__BENCH_RESULTS__);
console.log('\nBENCH:');
console.table(b.rows);
if (b.failures.length) b.failures.forEach((f) => console.log('  ❌ ' + f));

await browser.close();

const ok = t.failed === 0 && b.failures.length === 0 && errors.length === 0;
if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));
console.log(`\n${ok ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(ok ? 0 : 1);
