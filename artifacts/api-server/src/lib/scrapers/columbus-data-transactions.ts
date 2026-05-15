/**
 * Columbus Data Transaction Scraper (Scraper 2)
 *
 * Strategy:
 * 1. Login once via Puppeteer — extract session cookie
 * 2. For every terminal, make direct HTTP requests (no browser per terminal):
 *    a. GET ReportViewer.aspx → extract ViewState + ControlID
 *    b. POST with ViewState + TermID parameter → triggers UpdatePanel render
 *    c. GET CSV export using ControlID → clean structured data
 *    d. Fall back to HTML table parse from the UpdatePanel response body
 *
 * This is far more reliable and ~10× faster than spawning browser tabs per terminal.
 */

import puppeteer, { type Browser } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL         = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const REPORT_BASE       = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx";
const REPORT_NAME       = "rptTransactionDetailByTIDWithBalance";
const SSRS_HANDLER_BASE = "https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd";
const SSRS_VERSION      = "12.0.2402.15";

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
  logger.info({ terminals: terminalIds.length }, "Columbus Tx: starting fetch-based scraper");

  // ── Step 1: Login via Puppeteer to capture the session cookie ─────────────
  const sessionCookie = await loginAndGetCookie(username, password);
  logger.info({ hasCookie: !!sessionCookie }, "Columbus Tx: login complete");

  if (!sessionCookie) {
    throw new Error("Columbus Tx: login failed — no session cookie obtained");
  }

  // ── Step 2: Scrape all terminals concurrently (limited concurrency) ────────
  const CONCURRENCY = 4;
  const result = new Map<string, ColumbusTransactionRecord[]>();
  const queue = [...terminalIds];

  async function worker() {
    while (queue.length > 0) {
      const termId = queue.shift();
      if (!termId) break;
      try {
        const records = await scrapeTerminalViaHTTP(sessionCookie, termId);
        result.set(termId, records);
        logger.info({ termId, count: records.length }, "Columbus Tx: terminal done");
      } catch (err) {
        logger.warn({ termId, err: (err as Error).message }, "Columbus Tx: terminal error");
        result.set(termId, []);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  logger.info({ terminals: result.size }, "Columbus Tx: all terminals complete");
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Login via Puppeteer, return the session cookie string
// ─────────────────────────────────────────────────────────────────────────────

async function loginAndGetCookie(username: string, password: string): Promise<string | null> {
  let browser: Browser | null = null;
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

    if (/login/i.test(page.url())) {
      logger.error("Columbus Tx: still on login page after submit");
      return null;
    }

    // Extract ALL cookies and build a cookie header string
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    logger.info({ cookieCount: cookies.length, names: cookies.map(c => c.name) }, "Columbus Tx: extracted cookies");
    return cookieStr;
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrape a single terminal using direct HTTP requests
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeTerminalViaHTTP(
  cookieStr: string,
  termId: string,
): Promise<ColumbusTransactionRecord[]> {
  const endDate   = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 60);
  const start = formatDate(startDate);
  const end   = formatDate(endDate);

  const baseHeaders = {
    "Cookie": cookieStr,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // ── Step A: GET the report page (includes ViewState + ControlID) ──────────
  const reportUrl =
    `${REPORT_BASE}?reportname=${REPORT_NAME}` +
    `&TermID=${encodeURIComponent(termId)}` +
    `&StartDate=${encodeURIComponent(start)}` +
    `&EndDate=${encodeURIComponent(end)}`;

  logger.debug({ termId, reportUrl }, "Columbus Tx: GET report page");
  const getResp = await fetchWithTimeout(reportUrl, {
    method: "GET",
    headers: baseHeaders,
  }, 30_000);

  const pageHtml = await getResp.text();

  if (!pageHtml || pageHtml.length < 100) {
    logger.warn({ termId, status: getResp.status, bodyLen: pageHtml.length }, "Columbus Tx: empty GET response");
    return [];
  }

  // Detect login redirect
  if (/<title[^>]*>.*login.*/i.test(pageHtml) || /UsernameTextbox/i.test(pageHtml)) {
    logger.error({ termId }, "Columbus Tx: session expired — redirected to login");
    return [];
  }

  logger.debug({ termId, bodyLen: pageHtml.length, status: getResp.status }, "Columbus Tx: page loaded");

  // ── Extract hidden form fields ────────────────────────────────────────────
  const viewState          = extractInputValue(pageHtml, "__VIEWSTATE");
  const viewStateGenerator = extractInputValue(pageHtml, "__VIEWSTATEGENERATOR");
  const eventValidation    = extractInputValue(pageHtml, "__EVENTVALIDATION");
  const controlId          = extractControlId(pageHtml);

  logger.debug({ termId, hasViewState: !!viewState, controlId }, "Columbus Tx: form fields extracted");

  if (!viewState) {
    logger.warn({ termId, bodySnippet: pageHtml.substring(0, 300) }, "Columbus Tx: no __VIEWSTATE found — page may be wrong");
    return [];
  }

  // ── Step B: POST to trigger the UpdatePanel (runs the report) ────────────
  // The SSRS ReportViewer uses ScriptManager async postback with target ReportViewer1$ctl03
  const formData = new URLSearchParams();
  formData.set("ScriptManager1",                            "ScriptManager1|ReportViewer1$ctl03");
  formData.set("__EVENTTARGET",                             "ReportViewer1$ctl03");
  formData.set("__EVENTARGUMENT",                           "");
  formData.set("__VIEWSTATE",                               viewState);
  formData.set("__VIEWSTATEGENERATOR",                      viewStateGenerator ?? "");
  formData.set("__EVENTVALIDATION",                         eventValidation ?? "");
  formData.set("ReportViewer1$ctl03$ctl00",                 termId);  // First param = TermID
  formData.set("ReportViewer1$ctl03$ctl01",                 start);   // Second param = StartDate
  formData.set("ReportViewer1$ctl10",                       "");
  formData.set("ReportViewer1$ctl11",                       "quirks");
  formData.set("ReportViewer1$AsyncWait$HiddenCancelField", "False");
  formData.set("ReportViewer1$ToggleParam$store",           "");
  formData.set("ReportViewer1$ToggleParam$collapse",        "false");
  formData.set("ReportViewer1$ctl08$ClientClickedId",       "");
  formData.set("ReportViewer1$ctl07$store",                 "");
  formData.set("ReportViewer1$ctl07$collapse",              "true");
  formData.set("ReportViewer1$ctl09$ScrollPosition",        "");
  formData.set("ReportViewer1$ctl09$ReportControl$ctl04",   "100");
  formData.set("txtHideNotice",                             "False");

  logger.debug({ termId }, "Columbus Tx: POST to trigger report");
  const postResp = await fetchWithTimeout(
    `${REPORT_BASE}?reportname=${REPORT_NAME}`,
    {
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "X-MicrosoftAjax": "Delta=true",
        "Referer": reportUrl,
      },
      body: formData.toString(),
    },
    30_000,
  );

  const postBody = await postResp.text();
  logger.debug({ termId, postStatus: postResp.status, postBodyLen: postBody.length }, "Columbus Tx: POST response");

  // ── Step C: Try CSV export using the ControlID ───────────────────────────
  const effectiveControlId = controlId ?? extractControlId(postBody);
  if (effectiveControlId) {
    const csvRows = await tryFetchCSV(cookieStr, effectiveControlId, termId, baseHeaders);
    if (csvRows && csvRows.length > 0) {
      return csvRows;
    }
  } else {
    logger.debug({ termId }, "Columbus Tx: no ControlID found, skipping CSV export");
  }

  // ── Step D: Fall back to parsing HTML from the POST response ─────────────
  // The UpdatePanel response body contains rendered HTML fragments
  const tableRows = parseHtmlForTransactions(postBody, termId);
  if (tableRows && tableRows.length > 0) {
    logger.info({ termId, count: tableRows.length, method: "html-post" }, "Columbus Tx: got rows from POST body");
    return tableRows;
  }

  // Also try the original GET page HTML
  const getTableRows = parseHtmlForTransactions(pageHtml, termId);
  if (getTableRows && getTableRows.length > 0) {
    logger.info({ termId, count: getTableRows.length, method: "html-get" }, "Columbus Tx: got rows from GET body");
    return getTableRows;
  }

  logger.warn({ termId, controlId: effectiveControlId }, "Columbus Tx: no data found for terminal");
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Try fetching CSV export from the SSRS handler
// ─────────────────────────────────────────────────────────────────────────────

async function tryFetchCSV(
  cookieStr: string,
  controlId: string,
  termId: string,
  baseHeaders: Record<string, string>,
): Promise<ColumbusTransactionRecord[] | null> {
  try {
    const exportUrl =
      `${SSRS_HANDLER_BASE}` +
      `?OpType=Export` +
      `&Version=${encodeURIComponent(SSRS_VERSION)}` +
      `&ControlID=${controlId}` +
      `&Culture=en-US` +
      `&UICulture=en-US` +
      `&ReportStack=1` +
      `&ExportFormat=CSV`;

    logger.debug({ termId, exportUrl }, "Columbus Tx: trying CSV export");
    const resp = await fetchWithTimeout(exportUrl, { method: "GET", headers: baseHeaders }, 30_000);

    if (!resp.ok) {
      logger.debug({ termId, status: resp.status }, "Columbus Tx: CSV export HTTP error");
      return null;
    }

    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("text") && !contentType.includes("csv") && !contentType.includes("excel")) {
      logger.debug({ termId, contentType }, "Columbus Tx: CSV export wrong content-type");
      return null;
    }

    const csvText = await resp.text();
    if (!csvText || csvText.trim().length < 20) return null;

    const rows = parseCSV(csvText, termId);
    if (rows.length > 0) {
      logger.info({ termId, count: rows.length, method: "csv" }, "Columbus Tx: got rows via CSV");
    }
    return rows;
  } catch (err) {
    logger.debug({ termId, err: (err as Error).message }, "Columbus Tx: CSV export error");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: fetch with timeout
// ─────────────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: extract a hidden input value from HTML
// ─────────────────────────────────────────────────────────────────────────────

function extractInputValue(html: string, name: string): string | null {
  const re = new RegExp(
    `<input[^>]+?id="${name}"[^>]*?value="([^"]*)"`,
    "i",
  );
  const m = html.match(re);
  if (m) return m[1];
  // Try alternate ordering: value first then id
  const re2 = new RegExp(
    `<input[^>]+?name="${name}"[^>]*?value="([^"]*)"`,
    "i",
  );
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: extract SSRS ControlID from page HTML or response body
// ─────────────────────────────────────────────────────────────────────────────

function extractControlId(html: string): string | null {
  // Appears in: KeepAlive URL, JS variable, or UpdatePanel response
  const patterns = [
    /ControlID=([a-f0-9]{32})/i,
    /["']ControlID["']\s*[=:]\s*["']([a-f0-9]{32})["']/i,
    /controlId\s*=\s*["']([a-f0-9]{32})["']/i,
    /ReportViewerWebControl\.axd[^"']*ControlID=([a-f0-9]{32})/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse transaction table from raw HTML string
// ─────────────────────────────────────────────────────────────────────────────

function parseHtmlForTransactions(html: string, termId: string): ColumbusTransactionRecord[] {
  // Extract all <table>...</table> blocks
  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];

  let bestRows: ColumbusTransactionRecord[] = [];

  for (const tableHtml of tableMatches) {
    const lower = tableHtml.toLowerCase();
    let score = 0;
    if (lower.includes("tran"))      score += 3;
    if (lower.includes("card"))      score += 2;
    if (lower.includes("amt"))       score += 2;
    if (lower.includes("fee"))       score += 1;
    if (lower.includes("response"))  score += 1;
    if (score < 4) continue;

    const rows = parseTableHtml(tableHtml, termId);
    if (rows.length > bestRows.length) bestRows = rows;
  }

  return bestRows;
}

function parseTableHtml(tableHtml: string, termId: string): ColumbusTransactionRecord[] {
  // Strip HTML tags to get plain text rows
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  // Extract all rows: <tr>...</tr>
  const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (rowMatches.length < 2) return [];

  // Find the header row (contains tran + (amt or card))
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

  if (headerIdx < 0 || headers.length === 0) return [];

  const idx = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));

  const dateIdx    = idx("datetime") >= 0 ? idx("datetime") : idx("date") >= 0 ? idx("date") : 0;
  const typeIdx    = idx("trantype") >= 0 ? idx("trantype") : idx("type") >= 0 ? idx("type") : -1;
  const cardIdx    = idx("card") >= 0 ? idx("card") : -1;
  const amtReqdIdx = idx("amtreqd") >= 0 ? idx("amtreqd") : idx("amtrequested") >= 0 ? idx("amtrequested") : -1;
  const feeReqdIdx = idx("feereqd") >= 0 ? idx("feereqd") : idx("feelrequested") >= 0 ? idx("feelrequested") : -1;
  const amtDispIdx = idx("amtdisp") >= 0 ? idx("amtdisp") : idx("amtdispensed") >= 0 ? idx("amtdispensed") : -1;
  const feeAmtIdx  = idx("feeamt") >= 0 ? idx("feeamt") : idx("feeamount") >= 0 ? idx("feeamount") : -1;
  const seqIdx     = idx("termseq") >= 0 ? idx("termseq") : idx("seq") >= 0 ? idx("seq") : -1;
  const respIdx    = idx("response") >= 0 ? idx("response") : -1;

  const parseDollar = (s: string): number | null => {
    const n = parseFloat(s.replace(/[$,\s]/g, ""));
    return isNaN(n) ? null : n;
  };

  const records: ColumbusTransactionRecord[] = [];

  for (let i = headerIdx + 1; i < rowMatches.length; i++) {
    const cellMatches = rowMatches[i].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) ?? [];
    const cells = cellMatches.map(c => stripTags(c));
    if (cells.length < 2) continue;

    const dateRaw = cells[dateIdx] ?? "";
    if (!dateRaw || /^total|^grand|^sub/i.test(dateRaw)) continue;

    const g = (i2: number): string | null => (i2 >= 0 && cells[i2] ? cells[i2].trim() || null : null);

    records.push({
      terminalId:      termId,
      transactedAt:    dateRaw,
      transactionType: g(typeIdx),
      cardNumber:      g(cardIdx),
      amountRequested: amtReqdIdx >= 0 ? parseDollar(cells[amtReqdIdx] ?? "") : null,
      feeRequested:    feeReqdIdx >= 0 ? parseDollar(cells[feeReqdIdx] ?? "") : null,
      amountDispensed: amtDispIdx >= 0 ? parseDollar(cells[amtDispIdx] ?? "") : null,
      feeAmount:       feeAmtIdx >= 0 ? parseDollar(cells[feeAmtIdx] ?? "") : null,
      termSeq:         g(seqIdx),
      response:        g(respIdx),
    });
  }

  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse CSV text → transaction records
// ─────────────────────────────────────────────────────────────────────────────

function parseCSV(csv: string, termId: string): ColumbusTransactionRecord[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const result: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === "," && !inQuote) {
        result.push(cur.trim()); cur = "";
      } else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  };

  const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ""));
  const idx = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));

  const dateIdx    = idx("datetime") >= 0 ? idx("datetime") : idx("date") >= 0 ? idx("date") : 0;
  const typeIdx    = idx("trantype") >= 0 ? idx("trantype") : idx("type") >= 0 ? idx("type") : -1;
  const cardIdx    = idx("card") >= 0 ? idx("card") : -1;
  const amtReqdIdx = idx("amtreqd") >= 0 ? idx("amtreqd") : idx("amtrequested") >= 0 ? idx("amtrequested") : -1;
  const feeReqdIdx = idx("feereqd") >= 0 ? idx("feereqd") : idx("feelrequested") >= 0 ? idx("feelrequested") : -1;
  const amtDispIdx = idx("amtdisp") >= 0 ? idx("amtdisp") : idx("amtdispensed") >= 0 ? idx("amtdispensed") : -1;
  const feeAmtIdx  = idx("feeamt") >= 0 ? idx("feeamt") : idx("feeamount") >= 0 ? idx("feeamount") : -1;
  const seqIdx     = idx("termseq") >= 0 ? idx("termseq") : idx("seq") >= 0 ? idx("seq") : -1;
  const respIdx    = idx("response") >= 0 ? idx("response") : -1;

  const parseDollar = (s: string): number | null => {
    const n = parseFloat(s.replace(/[$,\s]/g, ""));
    return isNaN(n) ? null : n;
  };

  const records: ColumbusTransactionRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (cells.length < 2) continue;
    const dateRaw = cells[dateIdx]?.trim() ?? "";
    if (!dateRaw) continue;

    const g = (i2: number): string | null => (i2 >= 0 && cells[i2] ? cells[i2].trim() || null : null);
    records.push({
      terminalId:      termId,
      transactedAt:    dateRaw,
      transactionType: g(typeIdx),
      cardNumber:      g(cardIdx),
      amountRequested: amtReqdIdx >= 0 ? parseDollar(cells[amtReqdIdx] ?? "") : null,
      feeRequested:    feeReqdIdx >= 0 ? parseDollar(cells[feeReqdIdx] ?? "") : null,
      amountDispensed: amtDispIdx >= 0 ? parseDollar(cells[amtDispIdx] ?? "") : null,
      feeAmount:       feeAmtIdx >= 0 ? parseDollar(cells[feeAmtIdx] ?? "") : null,
      termSeq:         g(seqIdx),
      response:        g(respIdx),
    });
  }
  return records;
}
