// export-image.mjs
// Zero-install hi-res export of the WC2026 bracket to a poster-grade PNG + PDF.
//
// Drives an already-installed Chromium-based browser (Edge or Chrome) headlessly
// against dist/index.html — NO npm installs, only node: builtins + child_process.
//
// USAGE
//   node build-html.mjs            # (re)generate dist/index.html first
//   node export-image.mjs          # then render dist/exports/*.png + *.pdf
//
//   Refresh data: node build-html.mjs --refresh && node export-image.mjs
//
// BROWSER
//   Auto-detects Edge then Chrome at standard Windows paths. Override with:
//   BROWSER_PATH="C:\path\to\browser.exe" node export-image.mjs
//
// HOW IT WORKS
//   Loads index.html?poster=1 — a layout the app honors (build-html.mjs) that
//   renders the bracket at full natural width (~2.6k px) with no scroll clip —
//   then captures a full-page, 2x-DPI screenshot and a landscape PDF.

import { existsSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- locate a Chromium-based browser ---------------------------------------
const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function findBrowser() {
  for (const p of CANDIDATES) {
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      // headless Chromium often exits non-zero even on success; we verify by file.
      resolve({ code, err });
    });
  });
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MiB';
  return (bytes / 1024).toFixed(1) + ' KiB';
}

async function main() {
  const indexPath = join(__dirname, 'dist', 'index.html');
  if (!existsSync(indexPath)) {
    console.error('dist/index.html not found. Run `node build-html.mjs` first.');
    process.exit(1);
  }

  const browser = findBrowser();
  if (!browser) {
    console.error('No Chromium-based browser found.');
    console.error('Tried:\n  ' + CANDIDATES.join('\n  '));
    console.error('Set BROWSER_PATH to your browser .exe to override.');
    process.exit(2);
  }
  console.log(`Browser: ${browser}`);

  const outDir = join(__dirname, 'dist', 'exports');
  mkdirSync(outDir, { recursive: true });
  const pngOut = join(outDir, 'wc2026-bracket.png');
  const pdfOut = join(outDir, 'wc2026-bracket.pdf');

  // poster URL: full natural width, no scroll clip (layout implemented in build-html.mjs)
  const posterURL = pathToFileURL(indexPath).href + '?poster=1';

  // Generous window so the full bracket lands un-clipped; the app fixes its own
  // natural width, and --force-device-scale-factor=2 doubles the raster DPI.
  const W = 2800, H = 1800;

  const commonArgs = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--virtual-time-budget=8000`, // let the Monte-Carlo worker finish before capture
  ];

  // ---- PNG (full-page, 2x DPI) ----
  console.log('Rendering PNG (poster, 2x DPI)…');
  await run(browser, [
    ...commonArgs,
    '--force-device-scale-factor=2',
    `--window-size=${W},${H}`,
    `--screenshot=${pngOut}`,
    posterURL,
  ]);

  // ---- PDF (landscape, no header/footer) ----
  console.log('Rendering PDF (landscape)…');
  await run(browser, [
    ...commonArgs,
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfOut}`,
    '--print-to-pdf-no-header', // older flag alias; harmless if ignored
    posterURL,
  ]);

  // ---- report ----
  let ok = true;
  for (const [label, p] of [['PNG', pngOut], ['PDF', pdfOut]]) {
    if (existsSync(p)) {
      console.log(`${label}: ${p}  (${fmtSize(statSync(p).size)})`);
    } else {
      ok = false;
      console.error(`${label}: FAILED — ${p} was not produced.`);
    }
  }
  if (!ok) process.exit(3);
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
