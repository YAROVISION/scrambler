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
 *   --registry-concurrency  Паралельних запитів у Фазі 3 (за замовч.: 1)
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
const path  = require('path');

// ─── Аргументи ────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : def; };
const hasFlag = name => args.includes(`--${name}`);

const START_ID      = parseInt(getArg('start', '1'));
const END_ID        = parseInt(getArg('end', '100'));
const CONCURRENCY   = parseInt(getArg('concurrency', '3'));
const REG_CONC      = parseInt(getArg('registry-concurrency', '1'));
const OUTPUT_FILE   = getArg('output', 'results.json');
const TIMEOUT_MS    = parseInt(getArg('timeout', '15000'));
const PHASE1_ONLY   = hasFlag('phase1-only');
const PHASE2_ONLY   = hasFlag('phase2-only');
const RESUME        = hasFlag('resume');

// Нові аргументи для Фази 4 та GUI
const GUI              = hasFlag('gui');
const PORT             = parseInt(getArg('port', '3000'));
const DECISIONS_DIR    = getArg('decisions-dir', 'decisions');
const DECISIONS_FORMAT = getArg('decisions-format', 'md');
const INPUT_FILE       = getArg('input-file', '');
const PHASE4_ONLY      = hasFlag('phase4-only');

// Глобальний стан для GUI
let guiStatus = {
  running: false,
  total: 0,
  success: 0,
  error: 0,
  logs: []
};
let guiStopRequested = false;

const BASE_URL = 'https://lpd.court.gov.ua/legal-position';

// ─── Утиліти ──────────────────────────────────────────────────────────────────
const log = msg => {
  process.stdout.write(msg + '\n');
  if (typeof guiStatus !== 'undefined' && guiStatus.running) {
    guiStatus.logs.push(msg);
    if (guiStatus.logs.length > 100) {
      guiStatus.logs.shift();
    }
  }
};
const pct  = (done, total) => ((done / total) * 100).toFixed(1).padStart(5);
const esc  = s => (s || '').replace(/"/g, '""');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getNextRandomDelay(prevDelay) {
  // Генеруємо випадкову паузу від 5.0 до 15.0 секунд з точністю до 0.1 с
  // Гарантуємо відчутну різницю від попередньої паузи (як мінімум на 1.0 секунду),
  // щоб кожна наступна пауза завжди була іншою і не повторювалась.
  let delaySec;
  do {
    const tenths = Math.floor(Math.random() * (150 - 50 + 1)) + 50; // 50..150 -> 5.0..15.0 с
    delaySec = tenths / 10;
  } while (prevDelay && Math.abs(delaySec - (prevDelay / 1000)) < 1.0);

  return Math.round(delaySec * 1000);
}

// Конвертація HTML у Markdown для рішень
function htmlToMarkdown(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#171;/g, '«')
    .replace(/&#187;/g, '»')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

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

  // Спочатку пробуємо витягти дату ухвалення рішення з тексту самого рішення (всередині #txtdepository)
  const textMatch = html.match(/<textarea id="txtdepository">([\s\S]*?)<\/textarea>/i);
  if (textMatch) {
    const docText = textMatch[1];
    const months = {
      'січня': '01', 'лютого': '02', 'березня': '03', 'квітня': '04',
      'травня': '05', 'червня': '06', 'липня': '07', 'серпня': '08',
      'вересня': '09', 'жовтня': '10', 'листопада': '11', 'грудня': '12'
    };
    const clean = docText.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const m = clean.match(/(\d{1,2})\s+([а-яА-ЯіІїЇєЄїієґҐ]+)\s+(\d{4})/);
    if (m) {
      const day = m[1].padStart(2, '0');
      const monthName = m[2].toLowerCase();
      const year = m[3];
      if (months[monthName]) {
        date = `${day}.${months[monthName]}.${year}`;
      }
    }
  }

  // Варіант 1: "Надіслано судом: 30.10.2018" (з урахуванням HTML-тегів, наприклад <b>)
  if (!date) {
    const d1 = html.match(/Надіслано судом[:\s]*(?:<[^>]+>)*\s*(\d{2}\.\d{2}\.\d{4})/i);
    if (d1) date = d1[1];
  }

  // Варіант 2: "Зареєстровано: 30.10.2018" (з урахуванням HTML-тегів, наприклад <b>)
  if (!date) {
    const d2 = html.match(/Зареєстровано[:\s]*(?:<[^>]+>)*\s*(\d{2}\.\d{2}\.\d{4})/i);
    if (d2) date = d2[1];
  }

  // Варіант 2.5: "Дата набрання законної сили: 10.10.2019" (з урахуванням HTML-тегів)
  if (!date) {
    const d_force = html.match(/Дата набрання законної сили[:\s&nbsp;]*(?:<[^>]+>)*\s*(\d{2}\.\d{2}\.\d{4})/i);
    if (d_force) date = d_force[1];
  }

  // Варіант 3: перша дата формату DD.MM.YYYY в тексті рішення
  if (!date && textMatch) {
    const docText = textMatch[1];
    const d3 = docText.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (d3) date = d3[1];
  }

  // Варіант 4: перша дата формату DD.MM.YYYY у всьому тексті документа (крайній випадок)
  if (!date) {
    const d4 = html.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (d4) date = d4[1];
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

      // ─── Збереження рішення (Фаза 4) ───────────────────────────────────────
      try {
        const textMatch = body.match(/<textarea id="txtdepository">([\s\S]*?)<\/textarea>/i);
        if (textMatch) {
          const rawHtmlText = textMatch[1];
          let outputContent = '';
          let fileExt = 'md';

          if (DECISIONS_FORMAT === 'html') {
            outputContent = rawHtmlText;
            fileExt = 'html';
          } else if (DECISIONS_FORMAT === 'txt') {
            outputContent = rawHtmlText.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
            fileExt = 'txt';
          } else {
            outputContent = htmlToMarkdown(rawHtmlText);
            fileExt = 'md';
          }

          if (!fs.existsSync(DECISIONS_DIR)) {
            fs.mkdirSync(DECISIONS_DIR, { recursive: true });
          }

          const fileName = `${url.split('/').pop()}.${fileExt}`;
          const filePath = path.join(DECISIONS_DIR, fileName);
          fs.writeFileSync(filePath, outputContent, 'utf8');
        }
      } catch (saveErr) {
        log(`        ⚠️ Помилка збереження файлу рішення для ${url}: ${saveErr.message}`);
      }

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

// Пул для Фази 3 та 4 (без браузера, звичайні HTTP-запити)
async function runHttpPool(urls, concurrency, total, initialDone = 0) {
  const queue = [...urls];
  const results = [];
  let done = initialDone;
  let lastDelay = null;

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

      if (queue.length > 0) {
        const randomDelay = getNextRandomDelay(lastDelay);
        lastDelay = randomDelay;
        log(`        ⏳ Очікування ${(randomDelay / 1000).toFixed(1)} секунд перед наступним запитом...`);
        await sleep(randomDelay);
      }
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

// ─── ФАЗА 4 та GUI допоміжні функції ──────────────────────────────────────────

async function selectSourceFile() {
  const dir = './result_phase3';
  if (!fs.existsSync(dir)) {
    throw new Error(`Папка ${dir} не існує. Створіть її або перевірте шлях.`);
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('_phase'));
  if (files.length === 0) {
    throw new Error(`У папці ${dir} не знайдено JSON-файлів результатів.`);
  }

  log('\n📂 Доступні файли результатів у папці result_phase3:');
  files.forEach((f, i) => {
    log(`  [${i + 1}] ${f}`);
  });

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => new Promise((resolve) => {
    rl.question('\nВведіть номер файлу для обробки (або Enter для виходу): ', (ans) => {
      if (ans.trim() === '') {
        rl.close();
        log('🚪 Вихід із програми.');
        process.exit(0);
      }

      const idx = parseInt(ans.trim(), 10) - 1;
      if (idx >= 0 && idx < files.length) {
        rl.close();
        resolve(path.join(dir, files[idx]));
      } else {
        log('❌ Невірний номер. Спробуйте ще раз.');
        resolve(ask());
      }
    });
  });

  return ask();
}

async function runHttpPoolGui(urls, concurrency, total, initialDone = 0) {
  const queue = [...urls];
  let done = initialDone;
  let lastDelay = null;

  async function worker() {
    while (queue.length > 0) {
      if (guiStopRequested) {
        break;
      }
      const url = queue.shift();
      if (!url) break;

      const result = await fetchRegistryEntry(url);
      done++;

      if (result.status === 'ok') {
        guiStatus.success++;
      } else {
        guiStatus.error++;
      }

      const p = pct(done, total);
      const icon = result.status === 'ok' ? '✅' : result.status === 'not_found' ? '⬜' : '❌';
      const info = result.status === 'ok'
        ? `№ ${result.caseNumber || '?'}  |  ${result.date || '?'}`
        : result.status;
      log(`[${p}%] ${icon} ${url.split('/').pop()}  →  ${info}`);

      if (queue.length > 0 && !guiStopRequested) {
        const randomDelay = getNextRandomDelay(lastDelay);
        lastDelay = randomDelay;
        log(`        ⏳ Очікування ${(randomDelay / 1000).toFixed(1)} секунд перед наступним запитом...`);
        await sleep(randomDelay);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function runPhase4Background(filePath) {
  if (guiStatus.running) return;
  guiStatus.running = true;
  guiStatus.total = 0;
  guiStatus.success = 0;
  guiStatus.error = 0;
  guiStatus.logs = [];
  guiStopRequested = false;

  guiStatus.logs.push(`📖 Зчитуємо посилання з файлу ${filePath}...`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const urls = new Set();
    for (const item of data) {
      if (item.url) urls.add(item.url);
    }
    const registryUrls = [...urls];
    guiStatus.total = registryUrls.length;
    guiStatus.logs.push(`✅ Знайдено ${registryUrls.length} унікальних посилань.`);

    if (registryUrls.length === 0) {
      guiStatus.running = false;
      return;
    }

    if (!fs.existsSync(DECISIONS_DIR)) {
      fs.mkdirSync(DECISIONS_DIR, { recursive: true });
    }

    const fileExt = DECISIONS_FORMAT === 'html' ? 'html' : DECISIONS_FORMAT === 'txt' ? 'txt' : 'md';
    const pendingUrls = registryUrls.filter(url => {
      const fileName = `${url.split('/').pop()}.${fileExt}`;
      return !fs.existsSync(path.join(DECISIONS_DIR, fileName));
    });

    const alreadyDownloaded = registryUrls.length - pendingUrls.length;
    if (alreadyDownloaded > 0) {
      guiStatus.success = alreadyDownloaded;
      guiStatus.logs.push(`⏩ Пропущено ${alreadyDownloaded} вже завантажених рішень. Залишилось скачати: ${pendingUrls.length}`);
    }

    if (pendingUrls.length === 0) {
      guiStatus.logs.push('🎉 Усі рішення з цього файлу вже завантажено!');
      guiStatus.running = false;
      return;
    }

    await runHttpPoolGui(pendingUrls, REG_CONC, registryUrls.length, alreadyDownloaded);

  } catch (err) {
    guiStatus.logs.push(`❌ Помилка роботи: ${err.message}`);
  } finally {
    guiStatus.running = false;
  }
}

async function runPhase4Cli(inputFile) {
  let filePath = inputFile;
  if (!filePath) {
    filePath = await selectSourceFile();
  }

  log(`\n▶ Запуск Фази 4 для файлу: ${filePath}`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const urls = new Set();
  for (const item of data) {
    if (item.url) urls.add(item.url);
  }
  const registryUrls = [...urls];

  if (registryUrls.length === 0) {
    log('⚠️  Жодного посилання не знайдено у файлі.');
    return;
  }

  if (!fs.existsSync(DECISIONS_DIR)) {
    fs.mkdirSync(DECISIONS_DIR, { recursive: true });
  }

  const fileExt = DECISIONS_FORMAT === 'html' ? 'html' : DECISIONS_FORMAT === 'txt' ? 'txt' : 'md';
  const pendingUrls = registryUrls.filter(url => {
    const fileName = `${url.split('/').pop()}.${fileExt}`;
    return !fs.existsSync(path.join(DECISIONS_DIR, fileName));
  });

  const alreadyDownloaded = registryUrls.length - pendingUrls.length;
  if (alreadyDownloaded > 0) {
    log(`⏩ Пропущено ${alreadyDownloaded} вже завантажених рішень. Залишилось скачати: ${pendingUrls.length}`);
  }

  if (pendingUrls.length === 0) {
    log('🎉 Усі рішення з цього файлу вже завантажено!\n');
    return;
  }

  log(`\n▶ ФАЗА 4: Скачування текстів для ${pendingUrls.length} рішень (пропущено ${alreadyDownloaded})...\n`);

  await runHttpPool(pendingUrls, REG_CONC, registryUrls.length, alreadyDownloaded);
  log(`\n🎉 Фазу 4 завершено. Рішення збережено в папку: ${DECISIONS_DIR}\n`);
}

function startGuiServer() {
  const server = http.createServer(async (req, res) => {
    const urlParts = req.url.split('?');
    const pathname = urlParts[0];

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtmlContent());
    }
    else if (req.method === 'GET' && pathname === '/api/files') {
      const dir = './result_phase3';
      let files = [];
      if (fs.existsSync(dir)) {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('_phase'));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    }
    else if (req.method === 'POST' && pathname === '/api/start') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          if (!params.file) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Не вказано файл' }));
            return;
          }

          const filePath = path.join('./result_phase3', params.file);
          if (!fs.existsSync(filePath)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Файл не існує' }));
            return;
          }

          // Запуск скрейпінгу у фоні
          runPhase4Background(filePath);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    }
    else if (req.method === 'GET' && pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(guiStatus));
    }
    else if (req.method === 'POST' && pathname === '/api/stop') {
      guiStopRequested = true;
      guiStatus.logs.push('🛑 Отримано запит на зупинку. Завершуємо активні потоки...');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(PORT, () => {
    log(`\n💻 Сервер інтерфейсу запущено на http://localhost:${PORT}`);
  });

  return server;
}

function getHtmlContent() {
  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <title>Minimal Collective — Phase 4</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+Pro:wght@400;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Colors */
      --color-slate-dark: #141413;
      --color-ivory-medium: #f0eee6;
      --color-ivory-light: #faf9f5;
      --color-cloud-medium: #b0aea5;
      --color-cloud-dark: #87867f;
      --color-stone: #cccbc8;
      --color-slate-medium: #3d3d3a;
      --color-oat-warm: #e3dacc;
      --color-manilla: #f5e3c7;
      --color-clay: #d97757;
      --color-clay-deep: #c6613f;

      /* Font Families */
      --font-anthropic-serif: 'Source Serif Pro', Georgia, serif;
      --font-anthropic-sans: 'Inter', system-ui, -apple-system, sans-serif;
      --font-anthropic-mono: 'JetBrains Mono', monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--color-ivory-medium);
      color: var(--color-slate-dark);
      font-family: var(--font-anthropic-serif);
      font-size: 20px;
      line-height: 1.4;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .page-content {
      padding: 48px 48px 80px 48px;
      display: flex;
      flex-direction: column;
      align-items: center;
      flex-grow: 1;
    }

    .container {
      width: 100%;
      max-width: 1100px;
      display: flex;
      flex-direction: column;
      gap: 56px;
    }

    header {
      width: 100%;
      border-bottom: 1px solid var(--color-stone);
      padding-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }

    .logo {
      font-family: var(--font-anthropic-sans);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    .subtitle {
      font-family: var(--font-anthropic-sans);
      font-size: 12px;
      color: var(--color-cloud-dark);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    main {
      display: flex;
      flex-direction: column;
      gap: 48px;
      width: 100%;
    }

    .hero-section {
      max-width: 800px;
    }

    h1 {
      font-size: 61px;
      font-family: var(--font-anthropic-sans);
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.12px;
      color: var(--color-slate-dark);
      margin-bottom: 20px;
    }

    .description {
      font-size: 20px;
      font-family: var(--font-anthropic-serif);
      color: var(--color-slate-dark);
      line-height: 1.4;
    }

    .grid-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 32px;
      width: 100%;
    }

    @media (max-width: 768px) {
      .grid-layout {
        grid-template-columns: 1fr;
      }
    }

    .editorial-card {
      background-color: var(--color-ivory-light);
      border: 1px solid var(--color-stone);
      border-radius: 24px;
      padding: 32px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .card-title {
      font-family: var(--font-anthropic-sans);
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--color-cloud-dark);
      border-bottom: 1px solid var(--color-stone);
      padding-bottom: 12px;
    }

    .control-group {
      display: flex;
      flex-direction: column;
      gap: 16px;
      width: 100%;
    }

    label {
      font-family: var(--font-anthropic-sans);
      font-size: 14px;
      font-weight: 500;
      color: var(--color-slate-dark);
    }

    .select-wrapper {
      position: relative;
      width: 100%;
    }

    select {
      background-color: var(--color-ivory-light);
      color: var(--color-slate-dark);
      border: 1px solid var(--color-cloud-dark);
      border-radius: 12px;
      padding: 14px 40px 14px 16px;
      font-size: 16px;
      font-family: var(--font-anthropic-sans);
      width: 100%;
      outline: none;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg fill='%23141413' height='24' viewBox='0 0 24 24' width='24' xmlns='http://www.w3.org/2000/svg'><path d='M7 10l5 5 5-5z'/><path d='M0 0h24v24H0z' fill='none'/></svg>");
      background-repeat: no-repeat;
      background-position: right 14px center;
      transition: border-color 0.2s ease;
    }

    select:focus {
      border-color: var(--color-slate-dark);
    }

    .actions {
      display: flex;
      gap: 16px;
      margin-top: 8px;
    }

    button {
      font-family: var(--font-anthropic-sans);
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      cursor: pointer;
      outline: none;
      padding: 12px 32px;
      transition: all 0.2s ease;
    }

    .btn-primary {
      background-color: var(--color-clay);
      color: var(--color-ivory-light);
      border: none;
      border-radius: 0 0 8px 8px; /* Signature bottom-only border radius */
    }

    .btn-primary:hover {
      background-color: var(--color-clay-deep);
    }

    .btn-primary:disabled {
      background-color: var(--color-cloud-medium);
      color: var(--color-ivory-medium);
      cursor: not-allowed;
      opacity: 0.6;
    }

    .btn-secondary {
      background-color: transparent;
      color: var(--color-slate-dark);
      border: 1px solid var(--color-cloud-dark);
      border-radius: 12px; /* Outlined gets 12px radius */
    }

    .btn-secondary:hover:not(:disabled) {
      border-color: var(--color-slate-dark);
      background-color: rgba(20, 20, 19, 0.05);
    }

    .btn-secondary:disabled {
      color: var(--color-cloud-medium);
      border-color: var(--color-stone);
      cursor: not-allowed;
      opacity: 0.6;
    }

    .status-panel {
      display: flex;
      flex-direction: column;
      gap: 24px;
      width: 100%;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }

    .stat-box {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background-color: var(--color-oat-warm);
      padding: 16px;
      border-radius: 12px;
      border: 1px solid var(--color-stone);
    }

    .stat-label {
      font-family: var(--font-anthropic-sans);
      font-size: 12px;
      color: var(--color-cloud-dark);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 500;
    }

    .stat-val {
      font-family: var(--font-anthropic-serif);
      font-size: 32px;
      font-weight: 600;
      color: var(--color-slate-dark);
      line-height: 1;
    }

    .progress-container {
      width: 100%;
      height: 6px;
      background-color: var(--color-oat-warm);
      border-radius: 3px;
      overflow: hidden;
      border: 1px solid var(--color-stone);
    }

    .progress-bar {
      height: 100%;
      width: 0%;
      background-color: var(--color-clay);
      transition: width 0.3s ease;
    }

    .log-section {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .log-title {
      font-family: var(--font-anthropic-sans);
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--color-cloud-dark);
    }

    .console {
      width: 100%;
      height: 280px;
      border: 1px solid var(--color-stone);
      background-color: var(--color-ivory-light);
      font-family: var(--font-anthropic-mono);
      font-size: 14px;
      padding: 18px;
      overflow-y: auto;
      white-space: pre-wrap;
      color: var(--color-slate-dark);
      line-height: 1.5;
      border-radius: 12px;
    }

    .footer-inverted {
      background-color: var(--color-slate-dark);
      color: var(--color-ivory-light);
      padding: 48px;
      width: 100%;
      font-family: var(--font-anthropic-sans);
    }

    .footer-container {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    .footer-logo {
      font-weight: 700;
      margin-bottom: 4px;
    }

    .footer-tagline {
      color: var(--color-cloud-medium);
    }
  </style>
</head>
<body>
  <div class="page-content">
    <div class="container">
      <header>
        <div class="logo">Minimal Collective</div>
        <div class="subtitle">Phase 4 / Scrambler</div>
      </header>

      <main>
        <div class="hero-section">
          <h1>Скачування судових рішень</h1>
          <div class="description">Ця фаза дозволяє завантажити повні тексти рішень у форматі Markdown (.md) на основі вибраного файлу результатів попередніх етапів.</div>
        </div>

        <div class="grid-layout">
          <div class="editorial-card">
            <h2 class="card-title">Конфігурація запуску</h2>
            <div class="control-group">
              <label for="fileSelect">Оберіть файл результатів (result_phase3)</label>
              <div class="select-wrapper">
                <select id="fileSelect">
                  <option value="" disabled selected>Завантаження списку файлів...</option>
                </select>
              </div>
              <div class="actions">
                <button id="startBtn" class="btn-primary" onclick="startDownload()">Start</button>
                <button id="stopBtn" class="btn-secondary stop" onclick="stopDownload()" disabled>Stop</button>
              </div>
            </div>
          </div>

          <div class="editorial-card">
            <h2 class="card-title">Статус виконання</h2>
            <div class="status-panel">
              <div class="stats">
                <div class="stat-box">
                  <span class="stat-label">Усього посилань</span>
                  <span id="totalCount" class="stat-val">—</span>
                </div>
                <div class="stat-box">
                  <span class="stat-label">Скачано успішно</span>
                  <span id="successCount" class="stat-val">—</span>
                </div>
                <div class="stat-box">
                  <span class="stat-label">Помилок</span>
                  <span id="errorCount" class="stat-val">—</span>
                </div>
              </div>

              <div class="progress-container">
                <div id="progressBar" class="progress-bar"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="log-section">
          <h2 class="log-title">Журнал роботи (Console)</h2>
          <div id="consoleLog" class="console">Console: Ready.</div>
        </div>
      </main>
    </div>
  </div>

  <footer class="footer-inverted">
    <div class="footer-container">
      <div class="footer-left">
        <div class="footer-logo">Minimal Collective</div>
        <div class="footer-tagline">Phase 4 / Scrambler · v1.4.0</div>
      </div>
      <div class="footer-right">
        <span>scientific field journal on warm parchment</span>
      </div>
    </div>
  </footer>

  <script>
    let isRunning = false;
    let pollInterval = null;

    async function loadFiles() {
      try {
        const res = await fetch('/api/files');
        const files = await res.json();
        const select = document.getElementById('fileSelect');
        select.innerHTML = '';
        if (files.length === 0) {
          select.innerHTML = '<option value="" disabled>Нічого не знайдено в result_phase3</option>';
          document.getElementById('startBtn').disabled = true;
          return;
        }
        files.forEach(f => {
          const opt = document.createElement('option');
          opt.value = f;
          opt.textContent = f;
          select.appendChild(opt);
        });
      } catch (err) {
        showLog('❌ Помилка завантаження списку файлів: ' + err.message);
      }
    }

    function showLog(msg) {
      const consoleLog = document.getElementById('consoleLog');
      consoleLog.textContent += '\\n' + msg;
      consoleLog.scrollTop = consoleLog.scrollHeight;
    }

    async function startDownload() {
      const file = document.getElementById('fileSelect').value;
      if (!file) return;

      isRunning = true;
      document.getElementById('startBtn').disabled = true;
      document.getElementById('stopBtn').disabled = false;
      document.getElementById('fileSelect').disabled = true;

      document.getElementById('totalCount').textContent = '...';
      document.getElementById('successCount').textContent = '0';
      document.getElementById('errorCount').textContent = '0';
      document.getElementById('progressBar').style.width = '0%';
      document.getElementById('consoleLog').textContent = 'Console: Starting scraper for ' + file;

      try {
        await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file })
        });
        startPolling();
      } catch (err) {
        showLog('❌ Не вдалося запустити процес: ' + err.message);
        resetUI();
      }
    }

    async function stopDownload() {
      try {
        await fetch('/api/stop', { method: 'POST' });
        showLog('🚪 Надісано запит на зупинку...');
      } catch (err) {
        showLog('❌ Не вдалося надіслати запит на зупинку: ' + err.message);
      }
    }

    function startPolling() {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch('/api/status');
          const status = await res.json();

          document.getElementById('totalCount').textContent = status.total;
          document.getElementById('successCount').textContent = status.success;
          document.getElementById('errorCount').textContent = status.error;

          if (status.total > 0) {
            const pct = ((status.success + status.error) / status.total) * 100;
            document.getElementById('progressBar').style.width = pct + '%';
          }

          if (status.logs && status.logs.length > 0) {
            const consoleLog = document.getElementById('consoleLog');
            status.logs.forEach(l => {
              if (!consoleLog.textContent.includes(l)) {
                showLog(l);
              }
            });
          }

          if (!status.running && isRunning) {
            showLog('\\n🏁 Процес завершено.');
            resetUI();
          }
        } catch (err) {
          console.error('Error polling status:', err);
        }
      }, 1000);
    }

    function resetUI() {
      isRunning = false;
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      document.getElementById('startBtn').disabled = false;
      document.getElementById('stopBtn').disabled = true;
      document.getElementById('fileSelect').disabled = false;
    }

    loadFiles();
  </script>
</body>
</html>`;
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

  // ─── Запуск GUI або Фази 4 ────────────────────────────────────────────────
  if (GUI) {
    const server = startGuiServer();
    log('🚀 Відкриваємо вікно графічного інтерфейсу...');
    const guiBrowser = await chromium.launch({ headless: false });
    const context = await guiBrowser.newContext({ viewport: { width: 1100, height: 850 } });
    const page = await context.newPage();
    
    try {
      await page.goto(`http://localhost:${PORT}`);
    } catch (pageErr) {
      log(`⚠️ Помилка відкриття сторінки: ${pageErr.message}. Спробуйте перейти вручну на http://localhost:${PORT}`);
    }

    return new Promise((resolve) => {
      guiBrowser.on('disconnected', () => {
        log('🔌 Вікно GUI закрите. Зупиняємо сервер...');
        server.close();
        resolve();
      });
    });
  }

  if (PHASE4_ONLY) {
    await runPhase4Cli(INPUT_FILE);
    return;
  }

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
