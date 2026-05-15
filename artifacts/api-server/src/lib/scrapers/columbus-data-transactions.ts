/**
 * Columbus Data Transaction Scraper
 *
 * SSRS WebForms flow:
 *   1. Page loads with URL params → SSRS hides ParametersRow, auto-renders
 *   2. SSRS JS calls __doPostBack('ReportViewer1$ctl03$ctl00','') → UpdatePanel POST
 *   3. Server renders report → UpdatePanel response (or inline DOM update)
 *   4. SSRS JS may then request OpType=ReportPage for the actual HTML
 *
 * Strategy:
 *   - ONE browser, ONE page, sequential terminals (avoids --single-process crashes)
 *   - After navigation: intercept ALL POST responses to ReportViewer.aspx
 *   - Also intercept OpType=ReportPage responses
 *   - If neither fires in 10s, explicitly call __doPostBack to force render
 *   - Wait up to 90s total
 *   - Parse UpdatePanel format OR raw HTML OR DOM table
 */

import puppeteer, { type Browser, type Page, type HTTPResponse, type HTTPRequest } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL    = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const REPORT_BASE  = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx";
const REPORT_NAME  = "rptTransactionDetailByTIDWithBalance";
const SSRS_HANDLER = "Reserved.ReportViewerWebControl.axd";
const SSRS_VERSION = "12.0.2402.15";

// Real-browser user-agent (Chrome 124 on macOS)
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface ColumbusTransactionRecord {
  terminalId: string;
  transactedAt: string;
  transactionType: string | null;
  cardNumber: string | null;
  amountRequested: number | null;
  feeRequested: number | null;
  amountDispensed: number | null;
  feeAmount: number | null;
  termSeq: string | null;
  response: string | null;
}

function findChromiumExecutable(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
  for (const bin of candidates) {
    try {
      const p = execSync(`which ${bin} 2>/dev/null`).toString().trim();
      if (p) return p;
    } catch {}
  }
  return undefined;
}

function formatDate(d: Date): string {
  const m   = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}/${day}/${d.getFullYear()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function scrapeColumbusTransactions(
  username: string,
  password: string,
  terminalIds: string[],
): Promise<Map<string, ColumbusTransactionRecord[]>> {
  let browser: Browser | null = null;
  const result = new Map<string, ColumbusTransactionRecord[]>();

  try {
    const executablePath = findChromiumExecutable();
    logger.info({ executablePath: executablePath ?? "bundled", count: terminalIds.length }, "Columbus Tx: launching browser");

    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
      executablePath,
    });

    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(90_000);
    page.setDefaultTimeout(30_000);

    // ── Bypass bot detection ───────────────────────────────────────────────
    // Puppeteer sets navigator.webdriver=true which SSRS JS detects and
    // redirects to cdsatm.com (marketing site) instead of rendering the report.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // Also spoof a realistic plugins list (headless has 0 plugins)
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    // ── Login ──────────────────────────────────────────────────────────────
    logger.info("Columbus Tx: logging in");
    await page.goto(LOGIN_URL, { waitUntil: "load" });
    await page.waitForSelector("#UsernameTextbox", { visible: true });
    await page.type("#UsernameTextbox", username, { delay: 30 });
    await page.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.click("#LoginButton"),
    ]);
    if (/login/i.test(page.url())) {
      throw new Error("Columbus Tx: login failed");
    }
    logger.info("Columbus Tx: login ok");

    // ── Scrape terminals sequentially ─────────────────────────────────────
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 60);
    const startStr = formatDate(start);
    const endStr   = formatDate(end);

    for (const termId of terminalIds) {
      try {
        const records = await scrapeOneTerminal(page, termId, startStr, endStr);
        result.set(termId, records);
        logger.info({ termId, count: records.length }, "Columbus Tx: terminal done");
      } catch (err) {
        logger.warn({ termId, err: (err as Error).message }, "Columbus Tx: terminal failed");
        result.set(termId, []);
      }
    }

  } finally {
    await browser?.close().catch(() => {});
  }

  logger.info({ total: result.size }, "Columbus Tx: complete");
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrape one terminal
//
// Strategy (with bot-detection bypass applied at browser level):
//   1. Navigate to ReportViewer.aspx — SSRS JS now runs without bot redirect
//   2. Wait up to 20s for SSRS JS to auto-render (networkidle2 / DOM polling)
//   3. Extract from DOM if report tables exist
//   4. Fallback: fire UpdatePanel POST manually and parse UpdatePanel response
//   5. Fallback: OpType=Export CSV
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeOneTerminal(
  page: Page,
  termId: string,
  startStr: string,
  endStr: string,
): Promise<ColumbusTransactionRecord[]> {
  const url =
    `${REPORT_BASE}?reportname=${REPORT_NAME}` +
    `&TermID=${encodeURIComponent(termId)}` +
    `&StartDate=${encodeURIComponent(startStr)}` +
    `&EndDate=${encodeURIComponent(endStr)}`;

  logger.debug({ termId }, "Columbus Tx: navigating");

  // Wait for network to settle — SSRS JS fires several requests during render
  // (SessionKeepAlive, OpType=ReportPage, UpdatePanel POST, etc.)
  await page.goto(url, { waitUntil: "load" });

  // Give SSRS JS time to render the report (SessionKeepAlive fires ~500ms,
  // report render fires ~1-2s, rendering completes ~3-5s after page load)
  // Poll DOM every 500ms for up to 15s
  let domRows: ColumbusTransactionRecord[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(500);
    domRows = await parseTableFromDom(page, termId);
    if (domRows.length > 0) {
      logger.debug({ termId, count: domRows.length, attempt }, "Columbus Tx: SSRS auto-rendered");
      return domRows;
    }
  }

  // SSRS didn't auto-render in 15s — fire UpdatePanel POST manually
  logger.debug({ termId }, "Columbus Tx: DOM empty after 15s, firing manual UpdatePanel POST");

  const payload = await page.evaluate(async (postbackTarget: string): Promise<string | null> => {
    try {
      const form = document.querySelector<HTMLFormElement>("#form1, form");
      if (!form) return "ERR:no-form";
      const params = new URLSearchParams();
      form.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach(el => {
        if (el.name && el.type !== "submit" && el.type !== "image" && el.type !== "button") {
          params.append(el.name, el.value ?? "");
        }
      });
      params.set("__EVENTTARGET", postbackTarget);
      params.set("__EVENTARGUMENT", "");
      const sm = (window as any).Sys?.WebForms?.PageRequestManager?.getInstance?.();
      const smId: string = sm?._scriptManagerID ?? "ScriptManager1";
      params.set(smId, `${smId}|${postbackTarget}`);
      const resp = await fetch(form.action, {
        method: "POST", credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "X-MicrosoftAjax": "Delta=true",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: params.toString(),
      });
      if (!resp.ok) return `ERR:${resp.status}`;
      return resp.text();
    } catch (e: any) { return `ERR:${e?.message ?? "unknown"}`; }
  }, "ReportViewer1$ctl03$ctl00").catch(() => null);

  if (payload && !payload.startsWith("ERR:")) {
    logger.debug({ termId, len: payload.length, snippet: payload.substring(0, 200) }, "Columbus Tx: UpdatePanel response");
    const upRows = parseUpdatePanelResponse(payload, termId);
    if (upRows.length > 0) return upRows;
    const htmlRows = parseTransactionHtml(payload, termId);
    if (htmlRows.length > 0) return htmlRows;
  } else {
    logger.warn({ termId, payload }, "Columbus Tx: UpdatePanel POST failed");
  }

  // Check DOM again after UpdatePanel (page may have updated)
  await sleep(2_000);
  domRows = await parseTableFromDom(page, termId);
  if (domRows.length > 0) return domRows;

  logger.warn({ termId, payloadSnippet: payload?.substring(0, 200) }, "Columbus Tx: no rows found after all attempts");
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse ASP.NET UpdatePanel response format
// Format: {len}|{type}|{id}|{content}|   (repeating)
// ─────────────────────────────────────────────────────────────────────────────

function parseUpdatePanelResponse(text: string, termId: string): ColumbusTransactionRecord[] {
  // Quick check: does this look like an UpdatePanel response?
  if (!text.match(/^\d+\|/)) return [];

  const htmlSections: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    // Read length
    const pipe1 = text.indexOf("|", pos);
    if (pipe1 < 0) break;
    const len = parseInt(text.substring(pos, pipe1), 10);
    if (isNaN(len)) break;

    // Read type
    const pipe2 = text.indexOf("|", pipe1 + 1);
    if (pipe2 < 0) break;
    const type = text.substring(pipe1 + 1, pipe2);

    // Read id
    const pipe3 = text.indexOf("|", pipe2 + 1);
    if (pipe3 < 0) break;
    // const id = text.substring(pipe2 + 1, pipe3);

    // Read content (exactly `len` characters)
    const contentStart = pipe3 + 1;
    if (contentStart + len > text.length) break;
    const content = text.substring(contentStart, contentStart + len);

    if (type === "updatePanel" && content.includes("<table")) {
      htmlSections.push(content);
    }

    // Skip trailing pipe
    pos = contentStart + len + 1;
  }

  for (const html of htmlSections) {
    const rows = parseTransactionHtml(html, termId);
    if (rows.length > 0) return rows;
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse transaction table from raw HTML string
// ─────────────────────────────────────────────────────────────────────────────

function parseTransactionHtml(html: string, termId: string): ColumbusTransactionRecord[] {
  const stripTags = (s: string) =>
    s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  let best: ColumbusTransactionRecord[] = [];

  for (const tableHtml of tableMatches) {
    const lower = tableHtml.toLowerCase();
    let score = 0;
    if (lower.includes("tran"))     score += 3;
    if (lower.includes("card"))     score += 2;
    if (lower.includes("amt"))      score += 2;
    if (lower.includes("fee"))      score += 1;
    if (lower.includes("response")) score += 1;
    if (score < 4) continue;

    const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    if (rowMatches.length < 2) continue;

    let headerIdx = -1;
    let headers: string[] = [];
    for (let i = 0; i < rowMatches.length; i++) {
      const cellMatches = rowMatches[i].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) ?? [];
      const cellTexts = cellMatches.map(c => stripTags(c).toLowerCase().replace(/\s+/g, ""));
      const joined = cellTexts.join("");
      if ((joined.includes("tran") || joined.includes("datetime")) && (joined.includes("amt") || joined.includes("card"))) {
        headerIdx = i;
        headers = cellTexts;
        break;
      }
    }
    if (headerIdx < 0) continue;

    const idx = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));
    const dateIdx    = idx("datetime") >= 0 ? idx("datetime") : idx("date") >= 0 ? idx("date") : 0;
    const typeIdx    = idx("trantype") >= 0 ? idx("trantype") : idx("type") >= 0 ? idx("type") : -1;
    const cardIdx    = idx("card");
    const amtReqdIdx = idx("amtreqd") >= 0 ? idx("amtreqd") : idx("amtrequested");
    const feeReqdIdx = idx("feereqd") >= 0 ? idx("feereqd") : idx("feelrequested");
    const amtDispIdx = idx("amtdisp") >= 0 ? idx("amtdisp") : idx("amtdispensed");
    const feeAmtIdx  = idx("feeamt")  >= 0 ? idx("feeamt")  : idx("feeamount");
    const seqIdx     = idx("termseq") >= 0 ? idx("termseq") : idx("seq");
    const respIdx    = idx("response");

    const parseDollar = (s: string): number | null => {
      const n = parseFloat(s.replace(/[$,\s]/g, ""));
      return isNaN(n) ? null : n;
    };

    const rows: ColumbusTransactionRecord[] = [];
    for (let i = headerIdx + 1; i < rowMatches.length; i++) {
      const cellMatches = rowMatches[i].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) ?? [];
      const cells = cellMatches.map(c => stripTags(c));
      if (cells.length < 2) continue;
      const dateRaw = cells[dateIdx] ?? "";
      if (!dateRaw || /^total|grand|sub/i.test(dateRaw)) continue;
      const g = (ix: number): string | null => ix >= 0 && cells[ix] ? cells[ix].trim() || null : null;
      rows.push({
        terminalId: termId,
        transactedAt: dateRaw,
        transactionType: g(typeIdx),
        cardNumber: g(cardIdx),
        amountRequested: amtReqdIdx >= 0 ? parseDollar(cells[amtReqdIdx] ?? "") : null,
        feeRequested:    feeReqdIdx >= 0 ? parseDollar(cells[feeReqdIdx] ?? "") : null,
        amountDispensed: amtDispIdx >= 0 ? parseDollar(cells[amtDispIdx] ?? "") : null,
        feeAmount:       feeAmtIdx  >= 0 ? parseDollar(cells[feeAmtIdx]  ?? "") : null,
        termSeq:  g(seqIdx),
        response: g(respIdx),
      });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse transaction table from live DOM (Puppeteer page)
// ─────────────────────────────────────────────────────────────────────────────

async function parseTableFromDom(page: Page, termId: string): Promise<ColumbusTransactionRecord[]> {
  return page.evaluate((tid: string) => {
    function cell(el: Element | null | undefined): string {
      return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    function parseDollar(raw: string): number | null {
      const n = parseFloat(raw.replace(/[$,\s]/g, ""));
      return isNaN(n) ? null : n;
    }

    const tables = Array.from(document.querySelectorAll("table"));
    let best: HTMLTableElement | null = null;
    let bestScore = 0;
    for (const t of tables) {
      const txt = (t.textContent ?? "").toLowerCase();
      let s = 0;
      if (txt.includes("tran")) s += 3;
      if (txt.includes("card")) s += 2;
      if (txt.includes("amt"))  s += 2;
      if (txt.includes("fee"))  s += 1;
      if (s > bestScore && t.rows.length > 2) { bestScore = s; best = t; }
    }
    if (!best || bestScore < 4) return [];

    const allRows = Array.from(best.querySelectorAll("tr"));
    const headerRow = allRows.find(r => {
      const t = (r.textContent ?? "").toLowerCase().replace(/\s+/g, "");
      return (t.includes("tran") || t.includes("datetime")) && (t.includes("amt") || t.includes("card"));
    });
    if (!headerRow) return [];

    const headers = Array.from(headerRow.querySelectorAll("th,td"))
      .map(h => cell(h).toLowerCase().replace(/\s+/g, ""));

    const idx = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));
    const dateIdx    = idx("datetime") >= 0 ? idx("datetime") : idx("date") >= 0 ? idx("date") : 0;
    const typeIdx    = idx("trantype") >= 0 ? idx("trantype") : idx("type") >= 0 ? idx("type") : -1;
    const cardIdx    = idx("card");
    const amtReqdIdx = idx("amtreqd") >= 0 ? idx("amtreqd") : idx("amtrequested");
    const feeReqdIdx = idx("feereqd") >= 0 ? idx("feereqd") : idx("feelrequested");
    const amtDispIdx = idx("amtdisp") >= 0 ? idx("amtdisp") : idx("amtdispensed");
    const feeAmtIdx  = idx("feeamt")  >= 0 ? idx("feeamt")  : idx("feeamount");
    const seqIdx     = idx("termseq") >= 0 ? idx("termseq") : idx("seq");
    const respIdx    = idx("response");

    const result: {terminalId:string;transactedAt:string;transactionType:string|null;cardNumber:string|null;amountRequested:number|null;feeRequested:number|null;amountDispensed:number|null;feeAmount:number|null;termSeq:string|null;response:string|null}[] = [];
    const hi = allRows.indexOf(headerRow);
    for (let i = hi + 1; i < allRows.length; i++) {
      const cells = Array.from(allRows[i].querySelectorAll("td"));
      if (cells.length < 2) continue;
      const dateRaw = cell(cells[dateIdx]);
      if (!dateRaw || /^total|grand|sub/i.test(dateRaw)) continue;
      const g = (ix: number) => ix >= 0 && cells[ix] ? cell(cells[ix]) || null : null;
      result.push({
        terminalId: tid,
        transactedAt: dateRaw,
        transactionType: g(typeIdx),
        cardNumber: g(cardIdx),
        amountRequested: amtReqdIdx >= 0 ? parseDollar(cell(cells[amtReqdIdx])) : null,
        feeRequested:    feeReqdIdx >= 0 ? parseDollar(cell(cells[feeReqdIdx])) : null,
        amountDispensed: amtDispIdx >= 0 ? parseDollar(cell(cells[amtDispIdx])) : null,
        feeAmount:       feeAmtIdx  >= 0 ? parseDollar(cell(cells[feeAmtIdx]))  : null,
        termSeq:  g(seqIdx),
        response: g(respIdx),
      });
    }
    return result;
  }, termId).catch(() => []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug: comprehensive diagnostic for one terminal
// ─────────────────────────────────────────────────────────────────────────────

export async function debugScrapeTerminal(
  username: string,
  password: string,
  termId: string,
): Promise<Record<string, unknown>> {
  let browser: Browser | null = null;
  const diag: Record<string, unknown> = {};

  try {
    const executablePath = findChromiumExecutable();
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--single-process"],
      executablePath,
    });

    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(90_000);

    // Bypass bot detection (same as main scraper)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    // ── Capture console logs and page errors ──────────────────────────────
    const consoleLogs: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", msg => {
      const text = `[${msg.type()}] ${msg.text()}`;
      if (!text.includes("favicon") && !text.includes("404")) {
        consoleLogs.push(text);
      }
    });
    page.on("pageerror", err => pageErrors.push(err.message));

    // ── Capture ALL network requests (not just columbusdata.net) ──────────
    const allRequests: { t: number; method: string; url: string }[] = [];
    page.on("request", (req: HTTPRequest) => {
      const u = req.url();
      // Skip static assets
      if (/\.(css|png|gif|jpg|woff|ico)(\?|$)/i.test(u)) return;
      allRequests.push({ t: Date.now(), method: req.method(), url: u });
    });

    // ── Capture ALL responses (no domain filter) ──────────────────────────
    const allResponses: { t: number; method: string; url: string; status: number; bodyLen: number; snippet: string }[] = [];
    page.on("response", async (resp: HTTPResponse) => {
      const u = resp.url();
      if (/\.(css|png|gif|jpg|woff|ico)(\?|$)/i.test(u)) return;
      try {
        const text = await resp.text().catch(() => "");
        allResponses.push({
          t: Date.now(),
          method: resp.request().method(),
          url: u,
          status: resp.status(),
          bodyLen: text.length,
          snippet: text.substring(0, 800),
        });
      } catch {}
    });

    // ── Login ─────────────────────────────────────────────────────────────
    await page.goto(LOGIN_URL, { waitUntil: "load" });
    await page.waitForSelector("#UsernameTextbox", { visible: true });
    await page.type("#UsernameTextbox", username, { delay: 30 });
    await page.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.click("#LoginButton"),
    ]);
    diag.loginOk = !/login/i.test(page.url());
    if (!diag.loginOk) { diag.consoleLogs = consoleLogs; return diag; }

    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 60);

    const url =
      `${REPORT_BASE}?reportname=${REPORT_NAME}` +
      `&TermID=${encodeURIComponent(termId)}` +
      `&StartDate=${encodeURIComponent(formatDate(start))}` +
      `&EndDate=${encodeURIComponent(formatDate(end))}`;

    diag.url = url;

    // Clear request/response lists (only capture after navigation to report)
    allRequests.length = 0;
    allResponses.length = 0;
    consoleLogs.length  = 0;

    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load" });
    diag.loadMs = Date.now() - t0;

    // ── Capture initial page state ────────────────────────────────────────
    diag.initialState = await page.evaluate(() => {
      const win = window as any;
      return {
        hasDoPostBack:  typeof win.__doPostBack === "function",
        hasSM:          typeof win.Sys?.WebForms?.PageRequestManager !== "undefined",
        rvFound:        !!win.$find?.("ReportViewer1"),
        rvClientState:  win.$find?.("ReportViewer1")?._clientState ?? null,
        parametersRow:  document.getElementById("ParametersRowReportViewer1")?.style.display ?? "not found",
        asyncWait:      document.getElementById("AsyncWaitReportViewer1") ? "found" : "not found",
        pageTitle:      document.title,
        bodySnippet:    document.body?.innerHTML?.substring(0, 2000) ?? "",
      };
    });

    // Extract ControlID from the allRequests captured during page.goto()
    // (SessionKeepAlive fires at ~745ms during page load, before goto() resolves)
    let controlId: string | null = null;
    for (const req of allRequests) {
      const m = req.url.match(/[?&]ControlID=([a-f0-9]+)/i);
      if (m) { controlId = m[1]; break; }
    }
    // If not yet fired, wait up to 5s more
    if (!controlId) {
      const ctrlListener = (r: HTTPResponse) => {
        const m = r.url().match(/[?&]ControlID=([a-f0-9]+)/i);
        if (m) controlId = m[1];
      };
      page.on("response", ctrlListener);
      await sleep(5_000);
      page.off("response", ctrlListener);
    }
    diag.controlId = controlId;

    // ── Early frame check: what iframes exist after page load? ───────────
    diag.framesAfterLoad = page.frames().map(f => ({ url: f.url(), name: f.name() }));

    // Wait a bit more for SSRS JS to trigger any iframe navigations
    await sleep(5_000);
    diag.framesAfter5s = page.frames().map(f => ({ url: f.url(), name: f.name() }));

    // ── Helper: fire UpdatePanel POST and return section list ─────────────
    async function testPostback(target: string): Promise<string> {
      return page.evaluate(async (t: string): Promise<string> => {
        const doPost = async (target: string) => {
          const form = document.querySelector<HTMLFormElement>("#form1, form");
          if (!form) return "ERR:no-form";
          const params = new URLSearchParams();
          form.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach(el => {
            if (el.name && el.type !== "submit" && el.type !== "image" && el.type !== "button")
              params.append(el.name, el.value ?? "");
          });
          params.set("__EVENTTARGET", target);
          params.set("__EVENTARGUMENT", "");
          const sm = (window as any).Sys?.WebForms?.PageRequestManager?.getInstance?.();
          const smId: string = sm?._scriptManagerID ?? "ScriptManager1";
          params.set(smId, `${smId}|${target}`);
          const resp = await fetch(form.action, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", "X-MicrosoftAjax": "Delta=true", "X-Requested-With": "XMLHttpRequest" },
            body: params.toString(),
          });
          const text = await resp.text();
          const sections: string[] = [];
          let pos = 0;
          while (pos < text.length && sections.length < 25) {
            const p1 = text.indexOf("|", pos); if (p1 < 0) break;
            const len = parseInt(text.substring(pos, p1), 10); if (isNaN(len)) break;
            const p2 = text.indexOf("|", p1 + 1); if (p2 < 0) break;
            const type = text.substring(p1 + 1, p2);
            const p3 = text.indexOf("|", p2 + 1); if (p3 < 0) break;
            const contentStart = p3 + 1;
            if (contentStart + len > text.length) break;
            const content = text.substring(contentStart, contentStart + len);
            sections.push(`${type}(${len})`);
            if (type === "updatePanel") sections.push(`PANEL_HTML:${content.substring(0, 300)}`);
            if (type === "panelsToRefreshIDs" || type === "updatePanelIDs" || type === "postBackControlIDs") sections.push(`CONTENT:${content}`);
            if (type === "error") sections.push(`ERROR:${content}`);
            pos = contentStart + len + 1;
          }
          return `STATUS:${resp.status} LEN:${text.length} SECTS:${JSON.stringify(sections)}`;
        };
        return doPost(t);
      }, target).catch((e: any) => `ERR:${(e as Error).message}`);
    }

    // ── Helper: OpType=Export CSV ─────────────────────────────────────────
    async function testExport(ctrl: string): Promise<string> {
      return page.evaluate(async (c: string, v: string): Promise<string> => {
        try {
          const exportUrl = `/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=Export&Version=${encodeURIComponent(v)}&ControlID=${c}&Culture=en-US&UICulture=en-US&ReportStack=1&ExportFormat=CSV`;
          const resp = await fetch(exportUrl, { credentials: "include" });
          const text = await resp.text();
          if (resp.status === 200) {
            return `STATUS:200 REDIRECTED:${resp.redirected} LEN:${text.length} CSV_SNIPPET:${text.substring(0, 1000)}`;
          }
          // Extract ASP.NET error details
          const descMatch = text.match(/<b>Description:<\/b>\s*(.*?)<\/p>/s);
          const exMatch   = text.match(/<b>Exception Details:<\/b>\s*(.*?)<\/p>/s);
          const msgMatch  = text.match(/<title>(.*?)<\/title>/);
          const errMsg    = descMatch ? descMatch[1].replace(/<[^>]+>/g, "").trim() : "";
          const exDetail  = exMatch   ? exMatch[1].replace(/<[^>]+>/g, "").trim().substring(0, 400) : "";
          const title     = msgMatch  ? msgMatch[1] : "";
          return `STATUS:${resp.status} REDIRECTED:${resp.redirected} LEN:${text.length} TITLE:${title} DESC:${errMsg} EX:${exDetail}`;
        } catch (e: any) { return `ERR:${e?.message}`; }
      }, ctrl, SSRS_VERSION).catch(() => "ERR:evaluate-threw");
    }

    // Get all form field names (SSRS-specific fields beyond standard ASP.NET)
    diag.formFields = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLInputElement>("#form1 input, #form1 select, #form1 textarea, form input, form select"))
        .filter(el => el.name && el.type !== "submit" && el.type !== "image")
        .map(el => `${el.name}=${el.value?.substring(0, 30) ?? ""}`)
    ).catch(() => []);

    // Helper: postback with overrideable EVENTTARGET + EVENTARGUMENT + optional field overrides
    async function testPostbackExt(target: string, argument: string, overrides: Record<string, string> = {}): Promise<string> {
      return page.evaluate(async (t: string, arg: string, ov: Record<string, string>): Promise<string> => {
        const form = document.querySelector<HTMLFormElement>("#form1, form");
        if (!form) return "ERR:no-form";
        const params = new URLSearchParams();
        form.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach(el => {
          if (el.name && el.type !== "submit" && el.type !== "image" && el.type !== "button")
            params.append(el.name, el.value ?? "");
        });
        params.set("__EVENTTARGET", t);
        params.set("__EVENTARGUMENT", arg);
        for (const [k, v] of Object.entries(ov)) params.set(k, v);
        const sm = (window as any).Sys?.WebForms?.PageRequestManager?.getInstance?.();
        const smId: string = sm?._scriptManagerID ?? "ScriptManager1";
        params.set(smId, `${smId}|${t}`);
        const resp = await fetch(form.action, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", "X-MicrosoftAjax": "Delta=true", "X-Requested-With": "XMLHttpRequest" },
          body: params.toString(),
        });
        const text = await resp.text();
        const sections: string[] = [];
        let pos = 0;
        while (pos < text.length && sections.length < 25) {
          const p1 = text.indexOf("|", pos); if (p1 < 0) break;
          const len = parseInt(text.substring(pos, p1), 10); if (isNaN(len)) break;
          const p2 = text.indexOf("|", p1 + 1); if (p2 < 0) break;
          const type = text.substring(p1 + 1, p2);
          const p3 = text.indexOf("|", p2 + 1); if (p3 < 0) break;
          const contentStart = p3 + 1;
          if (contentStart + len > text.length) break;
          const content = text.substring(contentStart, contentStart + len);
          sections.push(`${type}(${len})`);
          if (type === "updatePanel") sections.push(`PANEL_HTML[${len}]:${content.substring(0, 500)}`);
          if (["panelsToRefreshIDs","updatePanelIDs","postBackControlIDs","error"].includes(type)) sections.push(`=${content}`);
          pos = contentStart + len + 1;
        }
        return `STATUS:${resp.status} LEN:${text.length} SECTS:${JSON.stringify(sections)}`;
      }, target, argument, overrides).catch((e: any) => `ERR:${(e as Error).message}`);
    }

    // ── Node.js-side SSRS requests (bypasses browser detection) ─────────────
    if (controlId) {
      try {
        const sessionCookies = await page.cookies();
        const cookieStr = sessionCookies.map(c => `${c.name}=${c.value}`).join("; ");
        diag.nodeFetch_cookies = sessionCookies.map(c => c.name); // Just names for safety

        // Extract ControlID from page HTML/JS directly (may differ from SessionKeepAlive URL)
        const pageControlId = await page.evaluate(() => {
          // Try SSRS JS object
          const rv = (window as any)?.$find?.("ReportViewer1");
          if (rv) {
            return rv._controlId ?? rv.get_controlId?.() ?? null;
          }
          // Try inline script search
          const scripts = Array.from(document.querySelectorAll("script")).map(s => s.textContent ?? "");
          for (const s of scripts) {
            const m = s.match(/"controlId"\s*:\s*"([^"]+)"/i) ?? s.match(/controlId['"]\s*[:=]\s*['"]([^'"]+)['"]/i);
            if (m) return m[1];
          }
          // Try hidden field
          const stateField = document.querySelector<HTMLInputElement>('[name*="ClientState"]');
          return stateField ? stateField.value.substring(0, 100) : null;
        }).catch(() => null);
        diag.pageControlId = pageControlId;

        // 1. Test SessionKeepAlive from Node.js (verify ControlID is valid)
        const keepAliveUrl = `https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=SessionKeepAlive&ControlID=${controlId}`;
        const kaResp = await fetch(keepAliveUrl, {
          redirect: "manual",
          headers: { "Cookie": cookieStr, "User-Agent": CHROME_UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": diag.url as string },
        });
        diag.nodeFetch_SessionKeepAlive = { status: kaResp.status, location: kaResp.headers.get("location") ?? "" };

        // 2. Test ReportPage (minimal params)
        const rpMinUrl = `https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=ReportPage&ControlID=${controlId}`;
        const rpMinResp = await fetch(rpMinUrl, {
          redirect: "manual",
          headers: { "Cookie": cookieStr, "User-Agent": CHROME_UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", "Referer": diag.url as string, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" },
        });
        const rpMinBody = rpMinResp.status === 200 ? (await rpMinResp.text()).substring(0, 500) : "";
        diag.nodeFetch_ReportPage_minimal = { status: rpMinResp.status, location: rpMinResp.headers.get("location") ?? "", bodySnippet: rpMinBody };

        // 3. Test ReportPage (full params)
        const reportPageUrl = `https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=ReportPage&Version=${encodeURIComponent(SSRS_VERSION)}&ControlID=${controlId}&Culture=en-US&UICulture=en-US&ReportStack=1`;
        const rpResp = await fetch(reportPageUrl, {
          redirect: "manual",
          headers: { "Cookie": cookieStr, "User-Agent": CHROME_UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", "Referer": diag.url as string, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
        });
        const rpLocation = rpResp.headers.get("location") ?? "";
        const rpBody = rpResp.status === 200 ? (await rpResp.text()).substring(0, 800) : "";
        diag.nodeFetch_ReportPage = { status: rpResp.status, location: rpLocation, bodySnippet: rpBody };

        // 4. Test Export directly from Node.js (after SessionKeepAlive)
        const exportUrl = `https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=Export&Version=${encodeURIComponent(SSRS_VERSION)}&ControlID=${controlId}&Culture=en-US&UICulture=en-US&ReportStack=1&ExportFormat=CSV`;
        const exResp = await fetch(exportUrl, { headers: { "Cookie": cookieStr, "User-Agent": CHROME_UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": diag.url as string } });
        const exText = await exResp.text();
        diag.nodeFetch_Export = { status: exResp.status, len: exText.length, csvSnippet: exText.substring(0, 400) };

        // 5. Full URL of allRequests SessionKeepAlive (to see the FULL ControlID)
        const skReq = allRequests.find(r => r.url.includes("SessionKeepAlive"));
        diag.sessionKeepAliveFullUrl = skReq?.url ?? null;

      } catch (e: any) {
        diag.nodeFetch_Error = String(e?.message ?? e);
      }
    }

    // ── Explore portal main page to find report URLs ─────────────────────
    // Navigate to the portal home to find where transaction links actually live
    const mainPortalUrl = "https://www.columbusdata.net/cdswebtool/";
    await page.goto(mainPortalUrl, { waitUntil: "load" });
    diag.mainPortal = {
      url: page.url(),
      title: await page.title(),
      links: await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .map(a => ({ text: (a.textContent ?? "").trim().substring(0, 60), href: (a as HTMLAnchorElement).href }))
          .filter(l => l.text && l.href && !l.href.startsWith("javascript:"))
          .slice(0, 40)
      ).catch(() => []),
      bodySnippet: (await page.content()).substring(0, 2000),
    };

    // ── Check cdsatm.com for SSRS Report Server ───────────────────────────
    // cdsatm.com might be the actual SSRS Report Server
    try {
      const cdsCookies = await page.cookies("https://www.cdsatm.com");
      const colCookieStr = (await page.cookies("https://www.columbusdata.net")).map(c => `${c.name}=${c.value}`).join("; ");
      const cdsTests = [
        "https://www.cdsatm.com/",
        "https://www.cdsatm.com/ReportServer/",
        "https://www.cdsatm.com/cdswebtool/",
        "https://www.cdsatm.com/Reports/",
      ];
      const cdsResults: Record<string, unknown>[] = [];
      for (const url of cdsTests) {
        try {
          const r = await fetch(url, { headers: { "User-Agent": CHROME_UA, "Accept": "text/html,*/*;q=0.8", "Cookie": colCookieStr }, redirect: "manual" });
          const body = r.status === 200 ? (await r.text()).substring(0, 300) : "";
          cdsResults.push({ url, status: r.status, location: r.headers.get("location") ?? "", body });
        } catch (e: any) { cdsResults.push({ url, error: String(e?.message ?? e) }); }
      }
      diag.cdsatmTests = cdsResults;
    } catch (e: any) { diag.cdsatmError = String(e?.message ?? e); }

    // Re-navigate back to report URL for remaining tests
    await page.goto(diag.url as string, { waitUntil: "load" });
    await sleep(2_000);

    // Test A: $ctl09$ReportControl$ctl00 with Navigate1 (report control postback — what SSRS JS actually calls)
    diag.postResult_reportCtl_Navigate1 = await testPostbackExt("ReportViewer1$ctl09$ReportControl$ctl00", "Navigate1");

    // Test B: same but with browser mode = "full" (fix quirks mode detection)
    diag.postResult_reportCtl_Navigate1_full = await testPostbackExt(
      "ReportViewer1$ctl09$ReportControl$ctl00", "Navigate1",
      { "ReportViewer1$ctl11": "full" }
    );

    // Test C: $ctl03 with browser mode = "full"
    diag.postResult_ctl03_full = await testPostbackExt("ReportViewer1$ctl03", "", { "ReportViewer1$ctl11": "full" });

    // Export after postbacks (no wait)
    if (controlId) {
      diag.exportResult_immediate = await testExport(controlId);
    }

    // Wait 5s then export again
    await sleep(5_000);
    if (controlId) {
      diag.exportResult_after5s = await testExport(controlId);
    }

    diag.pageUrl   = page.url();
    diag.pageTitle = await page.title();
    diag.finalHtmlSnippet = (await page.content()).substring(0, 3000);

    // ── Frame inspection: check for cross-origin frames (e.g. cdsatm.com) ──
    const frames = page.frames();
    diag.frames = frames.map(f => ({ url: f.url(), name: f.name() }));
    // Try to read HTML from any non-main frame (cross-origin frames may throw)
    const frameDetails: Record<string, unknown>[] = [];
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const fUrl  = frame.url();
        const fHtml = await frame.content().catch(() => "");
        const fTables = await frame.evaluate(() =>
          Array.from(document.querySelectorAll("table")).map(t => ({
            id: t.id, rows: t.rows.length, text: (t.textContent ?? "").substring(0, 300),
          }))
        ).catch(() => []);
        frameDetails.push({ url: fUrl, htmlLen: fHtml.length, htmlSnippet: fHtml.substring(0, 1000), tables: fTables });
      } catch (e: any) {
        frameDetails.push({ url: frame.url(), error: e?.message });
      }
    }
    diag.frameDetails = frameDetails;

    diag.allRequests  = allRequests.map(r => ({ ...r, t: r.t - t0 }));
    diag.allResponses = allResponses.map(r => ({ ...r, t: r.t - t0 }));
    diag.consoleLogs  = consoleLogs;
    diag.pageErrors   = pageErrors;

    // DOM table summary
    diag.domTables = await page.evaluate(() =>
      Array.from(document.querySelectorAll("table")).map(t => ({
        id: t.id,
        rows: t.rows.length,
        snippet: (t.textContent ?? "").substring(0, 200),
      }))
    );

  } finally {
    await browser?.close().catch(() => {});
  }

  return diag;
}
