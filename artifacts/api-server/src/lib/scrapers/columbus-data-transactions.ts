/**
 * Columbus Data Transaction Scraper (Scraper 2)
 *
 * Key finding (from network/HTML investigation):
 *   When TermID + date params are in the URL, SSRS hides the parameter row and
 *   auto-renders by firing Reserved.ReportViewerWebControl.axd?OpType=ReportPage
 *   via JavaScript. Plain HTTP fetch cannot trigger this — Puppeteer is required.
 *
 * Strategy: ONE browser, ONE page, terminals scraped sequentially.
 *   - No multi-page concurrency (crashes under --single-process on EC2).
 *   - After navigation, wait for SSRS JS to fire the ReportPage XHR.
 *   - Capture report HTML from the XHR response directly (intercept network).
 *   - Fall back to DOM table parsing if interception misses it.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL      = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const REPORT_BASE    = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx";
const REPORT_NAME    = "rptTransactionDetailByTIDWithBalance";
const SSRS_HANDLER   = "Reserved.ReportViewerWebControl.axd";

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
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(30_000);

    // ── Login ──────────────────────────────────────────────────────────────
    logger.info("Columbus Tx: logging in");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#UsernameTextbox", { visible: true });
    await page.type("#UsernameTextbox", username, { delay: 30 });
    await page.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#LoginButton"),
    ]);
    if (/login/i.test(page.url())) {
      throw new Error("Columbus Tx: login failed");
    }
    logger.info("Columbus Tx: login ok");

    // ── Scrape terminals sequentially (single page — avoids --single-process crashes) ──
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
// Scrape one terminal — intercept the SSRS ReportPage XHR for its HTML
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

  // Intercept the SSRS ReportPage response — this is where the rendered HTML lives
  let reportHtml: string | null = null;

  const onResponse = async (response: import("puppeteer").HTTPResponse) => {
    try {
      if (
        response.url().includes(SSRS_HANDLER) &&
        response.url().includes("OpType=ReportPage")
      ) {
        const text = await response.text().catch(() => "");
        if (text.length > 100) {
          reportHtml = text;
          logger.debug({ termId, len: text.length }, "Columbus Tx: captured ReportPage XHR");
        }
      }
    } catch {}
  };
  page.on("response", onResponse);

  try {
    logger.debug({ termId }, "Columbus Tx: navigating");
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait up to 30s for the ReportPage XHR to fire and return data
    const deadline = Date.now() + 30_000;
    while (!reportHtml && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1_500));
    }

    // If we captured the ReportPage HTML, parse it
    if (reportHtml) {
      const rows = parseTransactionHtml(reportHtml, termId);
      if (rows.length > 0) return rows;
      logger.debug({ termId, htmlLen: reportHtml.length, snippet: reportHtml.substring(0, 200) }, "Columbus Tx: ReportPage captured but no rows parsed");
    } else {
      logger.debug({ termId }, "Columbus Tx: no ReportPage XHR seen, trying DOM");
    }

    // Fallback: read the DOM directly (SSRS may have rendered inline)
    const domRows = await parseTableFromDom(page, termId);
    if (domRows.length > 0) return domRows;

    logger.warn({ termId, gotReportHtml: !!reportHtml }, "Columbus Tx: no rows found");
    return [];
  } finally {
    page.off("response", onResponse);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse transaction table from DOM (Puppeteer page)
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
    const feeAmtIdx  = idx("feeamt") >= 0 ? idx("feeamt") : idx("feeamount");
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
// Parse transaction table from raw HTML string (ReportPage XHR body)
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
    const feeAmtIdx  = idx("feeamt") >= 0 ? idx("feeamt") : idx("feeamount");
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
// Debug: run one terminal and return diagnostics
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
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(30_000);

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#UsernameTextbox", { visible: true });
    await page.type("#UsernameTextbox", username, { delay: 30 });
    await page.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#LoginButton"),
    ]);
    diag.loginOk = !/login/i.test(page.url());
    if (!diag.loginOk) return diag;

    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 60);

    // Intercept ALL SSRS handler requests to see what's being fired
    const ssrsRequests: { url: string; status: number; bodyLen: number; snippet: string }[] = [];
    page.on("response", async (resp) => {
      try {
        if (resp.url().includes(SSRS_HANDLER)) {
          const text = await resp.text().catch(() => "");
          ssrsRequests.push({
            url: resp.url().replace(/https?:\/\/[^/]+/, ""),
            status: resp.status(),
            bodyLen: text.length,
            snippet: text.substring(0, 300),
          });
        }
      } catch {}
    });

    const url =
      `${REPORT_BASE}?reportname=${REPORT_NAME}` +
      `&TermID=${encodeURIComponent(termId)}` +
      `&StartDate=${encodeURIComponent(formatDate(start))}` +
      `&EndDate=${encodeURIComponent(formatDate(end))}`;

    diag.url = url;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait 20s to observe all SSRS XHRs
    await new Promise(r => setTimeout(r, 20_000));

    diag.ssrsRequests = ssrsRequests;
    diag.pageUrl = page.url();
    diag.pageTitle = await page.title();

    // Check DOM for any table data
    const tableInfo = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll("table"));
      return tables.map(t => ({
        id: t.id,
        rows: t.rows.length,
        snippet: (t.textContent ?? "").substring(0, 200),
      }));
    });
    diag.domTables = tableInfo;

    // Check for iframes
    const frameInfo = page.frames().map(f => ({ url: f.url(), name: f.name() }));
    diag.frames = frameInfo;

  } finally {
    await browser?.close().catch(() => {});
  }

  return diag;
}
