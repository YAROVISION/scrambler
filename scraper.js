#!/usr/bin/env node
/**
 * Scraper для lpd.court.gov.ua — трифазовий обхід
 *
 * ФАЗА 1: /legal-position/{posId}
 *         → знаходить усі doc_id на сторінці
 *
 * ФАЗА 2: /legal-position/{posId}/document/{docId}
 *         → знаходить посилання на reyestr.court.gov.ua
 *
 * ФАЗА 3: reyestr.court.gov.ua/Review/{id}
 *         → витягує номер справи (caseNumber) та дату (date)
 *
 * Підсумковий JSON:
 * [
 *   {
 *     "caseNumber": "671/1486/17",
 *     "date": "30.10.2018",
 *     "url": "https://reyestr.court.gov.ua/Review/77285671"
 *   },
 *   ...
 * ]
 *
 * Використання:
 *   node scraper.js [--start 1] [--end 100] [--concurrency 3] [--output results.json]
 *
 * Аргументи:
 *   --start            З якого position_id починати (за замовч.: 1)
 *   --end              До якого position_id (за замовч.: 100)
 *   --concurrency      Паралельних вкладок у Фазах 1 і 2 (за замовч.: 3)
 *   --registry-concurrency  Паралельних запитів у Фазі 3 (за замовч.: 8)
 *   --output           Фінальний JSON-файл (за замовч.: results.json)
 *   --timeout          Таймаут на сторінку в мс (за замовч.: 15000)
 *   --phase1-only      Зупинитись після Фази 1
 *   --phase2-only      Зупинитись після Фази 2 (зберегти сирі посилання)
 *   --resume           Пропустити Фази 1–2, взяти посилання з _phase2.json
 */

const { chromium } = require('playwright');
const https = require('https');
const http  = require('http');
const fs    = require('fs');

// ─── Аргументи ────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : def; };
const hasFlag = name => args.includes(`--${name}`);

const START_ID      = parseInt(getArg('start', '1'));
const END_ID        = parseInt(getArg('end', '100'));
const CONCURRENCY   = parseInt(getArg('concurrency', '3'));
const REG_CONC      = parseInt(getArg('registry-concurrency', '8'));
const OUTPUT_FILE   = getArg('output', 'results.json');
const TIMEOUT_MS    = parseInt(getArg('timeout', '15000'));
const PHASE1_ONLY   = hasFlag('phase1-only');
const PHASE2_ONLY   = hasFlag('phase2-only');
const RESUME        = hasFlag('resume');

const BASE_URL = 'https://lpd.court.gov.ua/legal-position';

// ─── Утиліти ──────────────────────────────────────────────────────────────────
const log  = msg => process.stdout.write(msg + '\n');
const pct  = (done, total) => ((done / total) * 100).toFixed(1).padStart(5);
const esc  = s => (s || '').replace(/"/g, '""');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── HTTP fetch (без браузера, для reyestr) ───────────────────────────────────
function fetchHtml(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'uk,en;q=0.9',
      },
      timeout: timeoutMs,
    }, res => {
      // Слідуємо редиректам
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── ФАЗА 1: Збираємо doc_id зі сторінки правової позиції ────────────────────
async function fetchDocIds(page, posId) {
  const url = `${BASE_URL}/${posId}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT_MS });
    await page.waitForSelector('a[href], h1', { timeout: TIMEOUT_MS }).catch(() => {});

    const docIds = await page.evaluate((posId) => {
      const ids = new Set();

      // Стратегія 1: /legal-position/{posId}/document/{docId}
      const pat1 = new RegExp(`/legal-position/${posId}/document/(\\d+)`, 'i');
      document.querySelectorAll('a[href]').forEach(a => {
        const m = (a.getAttribute('href') || a.href || '').match(pat1);
        if (m) ids.add(parseInt(m[1], 10));
      });

      // Стратегія 2: будь-яке /document/{docId}
      if (ids.size === 0) {
        document.querySelectorAll('a[href*="/document/"]').forEach(a => {
          const m = (a.getAttribute('href') || a.href || '').match(/\/document\/(\d+)/);
          if (m) ids.add(parseInt(m[1], 10));
        });
      }

      // Стратегія 3: JSON у inline-скриптах
      if (ids.size === 0) {
        document.querySelectorAll('script:not([src])').forEach(s => {
          const p = /"(?:documentId|docId|id)"\s*:\s*(\d+)/gi;
          let m;
          while ((m = p.exec(s.textContent)) !== null) ids.add(parseInt(m[1], 10));
        });
      }

      return [...ids].sort((a, b) => a - b);
    }, posId);

    const pageText  = await page.evaluate(() => document.body?.innerText?.trim() || '');
    const isNotFound = pageText.includes('404') ||
      /не знайден|не існує|сторінку не знайдено/i.test(pageText) ||
      pageText.length < 50;

    if (docIds.length === 0 && isNotFound) {
      return { posId, url, status: 'not_found', docIds: [] };
    }
    return { posId, url, status: docIds.length > 0 ? 'ok' : 'no_docs', docIds };
  } catch (err) {
    return { posId, url, status: 'error', error: err.message, docIds: [] };
  }
}

// ─── ФАЗА 2: Збираємо посилання на реєстр зі сторінки документа ──────────────
async function fetchDocLinks(page, posId, docId) {
  const url = `${BASE_URL}/${posId}/document/${docId}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT_MS });
    await page.waitForSelector('a[href], h1', { timeout: TIMEOUT_MS }).catch(() => {});

    const links = await page.evaluate(() => {
      const seen = new Map();
      const add = el => {
        const href = el.href || el.getAttribute('href') || '';
        if (href && (href.includes('reyestr.court.gov.ua') || href.includes('/Review/')) && !seen.has(href)) {
          seen.set(href, (el.innerText || el.textContent || '').trim());
        }
      };
      document.querySelectorAll('a[href*="reyestr.court.gov.ua"], a[href*="/Review/"]').forEach(add);
      const topRight = document.querySelector('[class*="absolute"][class*="top"][class*="right"], div.absolute.top-4.right-4');
      if (topRight) topRight.querySelectorAll('a[href]').forEach(add);
      return [...seen.entries()].map(([href, text]) => ({ href, text }));
    });

    return {
      posId, docId, url,
      status: links.length > 0 ? 'ok' : 'no_links',
      links,
    };
  } catch (err) {
    return { posId, docId, url, status: 'error', error: err.message, links: [] };
  }
}

// ─── ФАЗА 3: Витягуємо номер справи і дату з reyestr ─────────────────────────
/**
 * Парсить HTML сторінки реєстру.
 * Шукає:
 *   - Номер справи:  "Категорія справи № 671/1486/17:"  або  "Справа № 671/1486/17"
 *   - Дата рішення:  "Надіслано судом: 30.10.2018"
 *                    або дату у тексті рішення (перший рядок у документі)
 */
function parseRegistry(html, url) {
  // ── Номер справи ──────────────────────────────────────────────────────────
  let caseNumber = '';

  // Варіант 1: у таблиці метаданих — "Категорія справи № X/Y/Z:"
  const m1 = html.match(/Категорія справи\s*№\s*<[^>]*>\s*([\d\/\-а-яА-ЯіІїЇєЄ]+)/i)
           || html.match(/Категорія справи\s*№\s*([\d\/\-а-яА-ЯіІїЇєЄ]+)/i);
  if (m1) caseNumber = m1[1].trim();

  // Варіант 2: у тексті рішення — "Справа № 671/1486/17"
  if (!caseNumber) {
    const m2 = html.match(/Справа\s*(?:№|N)\s*([\d\/\-]+)/i);
    if (m2) caseNumber = m2[1].trim();
  }

  // Варіант 3: у підзаголовку — просто число виду ХХХ/ХХХХ/ХХ
  if (!caseNumber) {
    const m3 = html.match(/(\d{1,5}\/\d{1,7}\/\d{2,4})/);
    if (m3) caseNumber = m3[1].trim();
  }

  // ── Дата ──────────────────────────────────────────────────────────────────
  let date = '';

  // Варіант 1: "Надіслано судом: 30.10.2018"
  const d1 = html.match(/Надіслано судом[:\s]+(\d{2}\.\d{2}\.\d{4})/i);
  if (d1) date = d1[1];

  // Варіант 2: "Зареєстровано: 30.10.2018"
  if (!date) {
    const d2 = html.match(/Зареєстровано[:\s]+(\d{2}\.\d{2}\.\d{4})/i);
    if (d2) date = d2[1];
  }

  // Варіант 3: перша дата формату DD.MM.YYYY у тексті документа
  if (!date) {
    const d3 = html.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (d3) date = d3[1];
  }

  return { caseNumber, date };
}

async function fetchRegistryEntry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { status, body } = await fetchHtml(url);

      if (status === 429 || status === 503) {
        // Rate limit — чекаємо і повторюємо
        const wait = attempt * 3000;
        log(`        ⏳ Rate limit (${status}) на ${url}, чекаємо ${wait / 1000}с...`);
        await sleep(wait);
        continue;
      }

      if (status === 404) {
        return { url, status: 'not_found', caseNumber: '', date: '' };
      }

      const { caseNumber, date } = parseRegistry(body, url);
      return { url, status: 'ok', caseNumber, date };

    } catch (err) {
      if (attempt === retries) {
        return { url, status: 'error', error: err.message, caseNumber: '', date: '' };
      }
      await sleep(attempt * 2000);
    }
  }
  return { url, status: 'error', error: 'max retries', caseNumber: '', date: '' };
}

// ─── Воркер-пул ───────────────────────────────────────────────────────────────
async function runBrowserPool(browser, tasks, handler, { concurrency, total }, label) {
  const queue = [...tasks];
  const results = [];
  let done = 0;

  async function worker() {
    const page = await browser.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,mp3}', r => r.abort());

    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      const result = await handler(page, ...task);
      results.push(result);
      done++;

      const p = pct(done, total);
      const icon = result.status === 'ok' ? '✅' : result.status === 'not_found' ? '⬜' :
                   result.status === 'no_docs' ? '🔷' : result.status === 'no_links' ? '🔶' : '❌';

      if (label === 'phase1') {
        const ids = result.docIds || [];
        log(`[${p}%] ${icon} pos=${result.posId} → ${ids.length} doc_id: [${ids.join(', ')}]`);
      } else {
        const n = result.links?.length || 0;
        log(`[${p}%] ${icon} pos=${result.posId} / doc=${result.docId} → ${n} посилань`);
        (result.links || []).forEach(l => log(`        🔗 ${l.href}`));
      }
    }
    await page.close();
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// Пул для Фази 3 (без браузера, звичайні HTTP-запити)
async function runHttpPool(urls, concurrency, total) {
  const queue = [...urls];
  const results = [];
  let done = 0;

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;

      const result = await fetchRegistryEntry(url);
      results.push(result);
      done++;

      const p = pct(done, total);
      const icon = result.status === 'ok' ? '✅' : result.status === 'not_found' ? '⬜' : '❌';
      const info = result.status === 'ok'
        ? `№ ${result.caseNumber || '?'}  |  ${result.date || '?'}`
        : result.status;
      log(`[${p}%] ${icon} ${url.split('/').pop()}  →  ${info}`);

      // Невелика затримка щоб не спамити реєстр
      await sleep(200);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Збереження фінального результату ────────────────────────────────────────
function saveFinal(entries) {
  // Фінальний JSON у потрібному форматі
  const final = entries
    .filter(e => e.status === 'ok')
    .map(e => ({
      caseNumber: e.caseNumber,
      date:       e.date,
      url:        e.url,
    }));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(final, null, 2), 'utf8');

  // CSV (всі записи, включно з помилками)
  const csvFile = OUTPUT_FILE.replace(/\.json$/, '.csv');
  const lines = ['caseNumber,date,url,status,error'];
  for (const e of entries) {
    lines.push(`"${esc(e.caseNumber)}","${esc(e.date)}","${e.url}","${e.status}","${esc(e.error || '')}"`);
  }
  fs.writeFileSync(csvFile, '\uFEFF' + lines.join('\n'), 'utf8');

  return { csvFile, total: final.length };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log('='.repeat(65));
  log('📜  Scraper: lpd.court.gov.ua — трифазовий обхід');
  log(`    Правові позиції: ${START_ID} – ${END_ID}`);
  log(`    Паралельність: браузер=${CONCURRENCY}, реєстр=${REG_CONC}`);
  log(`    Результати → ${OUTPUT_FILE}`);
  log('='.repeat(65));

  const phase1File = OUTPUT_FILE.replace(/\.json$/, '_phase1.json');
  const phase2File = OUTPUT_FILE.replace(/\.json$/, '_phase2.json');

  const browser = await chromium.launch({ headless: true });

  try {
    let phase2Results;

    if (RESUME && fs.existsSync(phase2File)) {
      // ── Відновлення: пропускаємо Фази 1 і 2 ──────────────────────────────
      log(`\n⏩ --resume: завантажуємо Фазу 2 з ${phase2File}\n`);
      phase2Results = JSON.parse(fs.readFileSync(phase2File, 'utf8'));

    } else {
      // ── ФАЗА 1 ────────────────────────────────────────────────────────────
      log('\n▶ ФАЗА 1: Визначаємо doc_id для кожної правової позиції...\n');

      const posIds = [];
      for (let i = START_ID; i <= END_ID; i++) posIds.push(i);

      let phase1Results = await runBrowserPool(
        browser,
        posIds.map(id => [id]),
        fetchDocIds,
        { concurrency: CONCURRENCY, total: posIds.length },
        'phase1'
      );
      phase1Results.sort((a, b) => a.posId - b.posId);
      fs.writeFileSync(phase1File, JSON.stringify(phase1Results, null, 2), 'utf8');
      log(`\n   💾 Фаза 1 збережена → ${phase1File}`);

      if (PHASE1_ONLY) { log('\n   (--phase1-only: завершено)'); return; }

      // ── ФАЗА 2 ────────────────────────────────────────────────────────────
      const phase2Tasks = [];
      for (const r of phase1Results) {
        if (r.docIds?.length > 0) {
          for (const docId of r.docIds) phase2Tasks.push([r.posId, docId]);
        }
      }

      if (phase2Tasks.length === 0) {
        log('\n⚠️  Жодного документа не знайдено. Перевірте сайт або розширте діапазон.');
        return;
      }

      log(`\n▶ ФАЗА 2: Обходимо ${phase2Tasks.length} документів...\n`);

      phase2Results = await runBrowserPool(
        browser,
        phase2Tasks,
        fetchDocLinks,
        { concurrency: CONCURRENCY, total: phase2Tasks.length },
        'phase2'
      );
      phase2Results.sort((a, b) => a.posId - b.posId || a.docId - b.docId);
      fs.writeFileSync(phase2File, JSON.stringify(phase2Results, null, 2), 'utf8');
      log(`\n   💾 Фаза 2 збережена → ${phase2File}`);

      if (PHASE2_ONLY) { log('\n   (--phase2-only: завершено)'); return; }
    }

    // ── ФАЗА 3: Збираємо дані з реєстру ────────────────────────────────────
    // Збираємо всі унікальні URL реєстру
    const allRegistryUrls = new Set();
    for (const doc of phase2Results) {
      for (const link of (doc.links || [])) {
        if (link.href) allRegistryUrls.add(link.href);
      }
    }

    const registryUrls = [...allRegistryUrls];

    if (registryUrls.length === 0) {
      log('\n⚠️  Жодного посилання на реєстр не знайдено у Фазі 2.');
      return;
    }

    log(`\n▶ ФАЗА 3: Отримуємо дані з реєстру для ${registryUrls.length} рішень...\n`);

    const phase3Results = await runHttpPool(registryUrls, REG_CONC, registryUrls.length);
    phase3Results.sort((a, b) => a.url.localeCompare(b.url));

    const { csvFile, total: finalCount } = saveFinal(phase3Results);

    // ── Підсумок ──────────────────────────────────────────────────────────
    const p3_ok  = phase3Results.filter(r => r.status === 'ok').length;
    const p3_err = phase3Results.filter(r => r.status !== 'ok').length;

    log('\n' + '='.repeat(65));
    log('📊 Підсумок:');
    log(`   Фаза 3 — Реєстр судових рішень:`);
    log(`     ✅ Успішно:   ${p3_ok}  (з них у фінальному JSON: ${finalCount})`);
    log(`     ❌ Помилки:   ${p3_err}`);
    log(`\n   💾 Фінальний JSON → ${OUTPUT_FILE}`);
    log(`   📄 CSV           → ${csvFile}`);
    log('='.repeat(65));

    // Показуємо перші 5 записів як приклад
    const preview = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')).slice(0, 5);
    if (preview.length > 0) {
      log('\n   Перші записи:');
      log(JSON.stringify(preview, null, 2).split('\n').map(l => '   ' + l).join('\n'));
    }

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  log('Критична помилка: ' + err.message);
  log(err.stack || '');
  process.exit(1);
});
