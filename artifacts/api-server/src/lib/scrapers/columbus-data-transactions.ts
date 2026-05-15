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
// Root-cause findings (from debug):
//   - SSRS renders the report on the server during initial GET (URL params)
//   - SSRS JS then requests OpType=ReportPage via an iframe navigation
//   - That request redirects to cdsatm.com (server rejects it in headless mode)
//   - No UpdatePanel POST fires at all
//
// Fix: bypass SSRS JS completely. After the page loads (giving us a valid
//   ViewState + session), we fire the UpdatePanel POST ourselves from inside
//   the page context via fetch(). This carries the real session cookies, the
//   valid ViewState, and all required headers. The server renders the report
//   and returns it in the UpdatePanel response.
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
  await page.goto(url, { waitUntil: "load" });

  // Make the UpdatePanel postback from WITHIN the page (so session cookies
  // and origin headers are automatically correct)
  const payload = await page.evaluate(async (postbackTarget: string): Promise<string | null> => {
    try {
      const form = document.querySelector<HTMLFormElement>("#form1, form");
      if (!form) return "ERR:no-form";

      // Collect all form fields (hidden + text inputs)
      const params = new URLSearchParams();
      form.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach(el => {
        if (el.name && el.type !== "submit" && el.type !== "image" && el.type !== "button") {
          params.append(el.name, el.value ?? "");
        }
      });

      // Override postback fields for UpdatePanel async POST
      params.set("__EVENTTARGET", postbackTarget);
      params.set("__EVENTARGUMENT", "");

      // Add ScriptManager async-postback field
      const sm = (window as any).Sys?.WebForms?.PageRequestManager?.getInstance?.();
      const smId: string = sm?._scriptManagerID ?? "ScriptManager1";
      params.set(smId, `${smId}|${postbackTarget}`);

      const resp = await fetch(form.action, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "X-MicrosoftAjax": "Delta=true",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: params.toString(),
      });

      if (!resp.ok) return `ERR:${resp.status}`;
      return resp.text();
    } catch (e: any) {
      return `ERR:${e?.message ?? "unknown"}`;
    }
  }, "ReportViewer1$ctl03$ctl00").catch(() => null);

  if (!payload) {
    logger.warn({ termId }, "Columbus Tx: in-page fetch returned null");
    return await parseTableFromDom(page, termId);
  }

  if (payload.startsWith("ERR:")) {
    logger.warn({ termId, payload }, "Columbus Tx: in-page fetch error");
    return await parseTableFromDom(page, termId);
  }

  logger.debug({ termId, len: payload.length, snippet: payload.substring(0, 200) }, "Columbus Tx: UpdatePanel response received");

  // Try UpdatePanel pipe format first (ASP.NET async postback)
  const upRows = parseUpdatePanelResponse(payload, termId);
  if (upRows.length > 0) {
    logger.debug({ termId, count: upRows.length }, "Columbus Tx: parsed from UpdatePanel response");
    return upRows;
  }

  // Try as plain HTML (some SSRS versions return full HTML)
  const htmlRows = parseTransactionHtml(payload, termId);
  if (htmlRows.length > 0) {
    logger.debug({ termId, count: htmlRows.length }, "Columbus Tx: parsed from HTML response");
    return htmlRows;
  }

  logger.debug({ termId, payloadLen: payload.length, snippet: payload.substring(0, 400) }, "Columbus Tx: response captured but no rows parsed");

  // DOM fallback (in case the response updated the page)
  return await parseTableFromDom(page, termId);
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
          return `STATUS:${resp.status} REDIRECTED:${resp.redirected} LEN:${text.length} SNIPPET:${text.substring(0, 500)}`;
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
