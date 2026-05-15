/**
 * Columbus Data Portal Scraper — ATM Info & Status
 *
 * Strategy:
 * 1. Login
 * 2. Scrape TerminalStatusReport.aspx grid — terminal IDs, balance, last contact (fast, proven)
 * 3. Scrape rptTerminalListType — address, surcharge, property type, postal code
 *    Falls back to rptActiveTerminals if rptTerminalListType returns 0 rows.
 * 4. Merge and return
 */

import puppeteer, { type Browser, type Page, type Frame, type HTTPResponse } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL         = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const GRID_URL          = "https://www.columbusdata.net/cdswebtool/QuickView/TerminalStatusReport.aspx";
const TERM_LIST_URL     = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptTerminalListType";
const ACTIVE_TERMS_URL  = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptActiveTerminals";
const SSRS_HANDLER_BASE = "https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd";
const SSRS_VERSION      = "12.0.2402.15";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ColumbusTerminalStatus {
  terminalId: string;
  terminalLabel: string;
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  propertyType: string | null;
  makeModel: string | null;
  surcharge: number | null;
  currentBalance: number | null;
  lastContact: string | null;
  isOnline: boolean;
}

// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------

function findChromiumExecutable(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
  for (const bin of candidates) {
    try {
      const p = execSync(`which ${bin} 2>/dev/null`).toString().trim();
      if (p) { logger.info({ path: p }, "Columbus Data: found system Chromium"); return p; }
    } catch {}
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function scrapeColumbusData(
  username: string,
  password: string,
): Promise<ColumbusTerminalStatus[]> {
  let browser: Browser | null = null;
  try {
    const executablePath = findChromiumExecutable();
    logger.info({ executablePath: executablePath ?? "puppeteer-bundled" }, "Columbus Data: launching browser");

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--single-process"],
      executablePath,
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(90_000);
    page.setDefaultTimeout(30_000);

    // Bypass bot detection: SSRS JS detects navigator.webdriver=true and
    // redirects to cdsatm.com (blocking page) instead of rendering the report.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    // ── 1. Login ──────────────────────────────────────────────────────────
    logger.info("Columbus Data: logging in");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#UsernameTextbox", { visible: true });
    await page.type("#UsernameTextbox", username, { delay: 30 });
    await page.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#LoginButton"),
    ]);
    if (/login/i.test(page.url())) {
      throw new Error("Columbus Data login failed — still on login page");
    }
    logger.info("Columbus Data: login successful");

    // ── 2. Status grid — balance, last contact, terminal IDs ─────────────
    logger.info("Columbus Data: loading status grid");
    page.goto(GRID_URL).catch(() => {});
    const gridFound = await page
      .waitForSelector("table[id*='rgTermStatusReport']", { timeout: 45_000 })
      .then(() => true).catch(() => false);

    if (!gridFound) {
      throw new Error("Columbus Data: status grid not found after 45s");
    }

    // Try to expand page size
    try {
      const sizeInput = await page.$("#rgTermStatusReport_ctl00_ctl03_ctl01_PageSizeComboBox_Input");
      if (sizeInput) {
        await sizeInput.click({ clickCount: 3 });
        await sizeInput.type("500");
        await sizeInput.press("Enter");
        await new Promise(r => setTimeout(r, 3_000));
      }
    } catch { /* ignore */ }

    const gridRows = await scrapeStatusGrid(page);
    logger.info({ count: gridRows.length }, "Columbus Data: grid scraped");

    if (gridRows.length === 0) {
      throw new Error("Columbus Data: no rows found in status grid");
    }

    // ── 3. rptTerminalListType — address, surcharge, property type ────────
    let infoMap = await scrapeReportViewer(page, TERM_LIST_URL, "rptTerminalListType");

    if (infoMap.size === 0) {
      logger.warn("Columbus Data: rptTerminalListType returned 0 rows — trying rptActiveTerminals");
      infoMap = await scrapeReportViewer(page, ACTIVE_TERMS_URL, "rptActiveTerminals");
    }

    logger.info({ count: infoMap.size }, "Columbus Data: info report scraped");

    // ── 4. Merge ──────────────────────────────────────────────────────────
    const seen = new Set<string>();
    const results: ColumbusTerminalStatus[] = [];

    for (const row of gridRows) {
      if (seen.has(row.terminalId)) continue;
      seen.add(row.terminalId);

      const info = infoMap.get(row.terminalId);
      results.push({
        terminalId:    row.terminalId,
        terminalLabel: row.terminalLabel,
        locationName:  info?.locationName  ?? null,
        address:       info?.address       ?? null,
        city:          info?.city          ?? null,
        state:         info?.state         ?? null,
        postalCode:    info?.postalCode    ?? null,
        propertyType:  info?.propertyType  ?? null,
        makeModel:     info?.makeModel     ?? null,
        surcharge:     info?.surcharge     ?? null,
        currentBalance: row.currentBalance,
        lastContact:   row.lastContact,
        isOnline:      row.isOnline,
      });
    }

    logger.info({ total: results.length }, "Columbus Data: sync complete");
    return results;

  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// ReportViewer.aspx scraper
// Handles rptTerminalListType and rptActiveTerminals.
// SSRS reports render slowly and often inside iframes — this function
// polls all frames for up to 30 s and logs everything it finds.
// ---------------------------------------------------------------------------

interface InfoRow {
  terminalId: string;
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  propertyType: string | null;
  makeModel: string | null;
  surcharge: number | null;
}

async function scrapeReportViewer(
  page: Page,
  url: string,
  reportName: string,
): Promise<Map<string, InfoRow>> {
  logger.info({ url, reportName }, "Columbus Data: loading report");

  // Capture ControlID from SSRS KeepAlive (needed for CSV export fallback)
  let controlId: string | null = null;
  const onResponse = (r: HTTPResponse) => {
    const m = r.url().match(/[?&]ControlID=([a-f0-9]+)/i);
    if (m) controlId = m[1];
  };
  page.on("response", onResponse);

  const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  try {
    await page.goto(url, { waitUntil: "load" });

    // With bot-detection bypass (navigator.webdriver=undefined), SSRS JS
    // should now auto-render the report instead of redirecting to cdsatm.com.
    // Poll DOM every 500ms for up to 15s for auto-render.
    for (let i = 0; i < 30; i++) {
      await sleepMs(500);
      const allFrames: Frame[] = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
      for (const frame of allFrames) {
        try {
          const rows = await extractTableFromFrame(frame, reportName, frame.url()).catch(() => null);
          if (rows && rows.length > 0) {
            logger.info({ reportName, count: rows.length, method: "auto-render", attempt: i }, "Columbus Data: SSRS auto-rendered");
            const map = new Map<string, InfoRow>();
            for (const row of rows) { if (row.terminalId) map.set(row.terminalId, row); }
            return map;
          }
        } catch { /* cross-origin frame or detached */ }
      }
    }

    // SSRS didn't auto-render — fire UpdatePanel POST manually
    logger.debug({ reportName }, "Columbus Data: DOM empty after 15s, firing manual UpdatePanel POST");
    const reportPayload = await page.evaluate(async (postbackTarget: string): Promise<string | null> => {
      try {
        const form = document.querySelector<HTMLFormElement>("#form1, form");
        if (!form) return null;
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
        return resp.ok ? resp.text() : null;
      } catch { return null; }
    }, "ReportViewer1$ctl03$ctl00").catch(() => null);

    // ── Try parsing UpdatePanel / HTML payload ────────────────────────────
    if (reportPayload) {
      const rows = parseUpdatePanelForInfo(reportPayload) ?? parseHtmlForInfo(reportPayload);
      if (rows && rows.length > 0) {
        logger.info({ reportName, count: rows.length, method: "payload" }, "Columbus Data: got info rows from payload");
        const map = new Map<string, InfoRow>();
        for (const row of rows) { if (row.terminalId) map.set(row.terminalId, row); }
        return map;
      }
      logger.debug({ reportName, snippet: reportPayload.substring(0, 400) }, "Columbus Data: payload captured but no rows parsed");
    }

    // ── Try CSV export ────────────────────────────────────────────────────
    if (controlId) {
      const csvRows = await tryInfoCSVExport(page, controlId, reportName);
      if (csvRows && csvRows.length > 0) {
        logger.info({ reportName, count: csvRows.length, method: "csv" }, "Columbus Data: got info rows via CSV");
        const map = new Map<string, InfoRow>();
        for (const row of csvRows) { if (row.terminalId) map.set(row.terminalId, row); }
        return map;
      }
    }

    // ── Final fallback: DOM table scan across all frames ──────────────────
    const allFrames: Frame[] = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
    let bestRows: InfoRow[] = [];
    for (const frame of allFrames) {
      let frameUrl = "";
      try { frameUrl = frame.url(); } catch { continue; }
      const rows = await extractTableFromFrame(frame, reportName, frameUrl).catch(() => null);
      if (rows && rows.length > bestRows.length) bestRows = rows;
    }

    if (bestRows.length === 0) {
      const snippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "");
      logger.warn({ reportName, bodySnippet: snippet }, "Columbus Data: no rows found after all attempts");
    }

    const map = new Map<string, InfoRow>();
    for (const row of bestRows) { if (row.terminalId) map.set(row.terminalId, row); }
    return map;

  } finally {
    page.off("response", onResponse);
  }
}

// Parse ASP.NET UpdatePanel pipe-delimited response
function parseUpdatePanelForInfo(text: string): InfoRow[] | null {
  if (!text.match(/^\d+\|/)) return null;
  const htmlSections: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const pipe1 = text.indexOf("|", pos);
    if (pipe1 < 0) break;
    const len = parseInt(text.substring(pos, pipe1), 10);
    if (isNaN(len)) break;
    const pipe2 = text.indexOf("|", pipe1 + 1);
    if (pipe2 < 0) break;
    const type = text.substring(pipe1 + 1, pipe2);
    const pipe3 = text.indexOf("|", pipe2 + 1);
    if (pipe3 < 0) break;
    const contentStart = pipe3 + 1;
    if (contentStart + len > text.length) break;
    const content = text.substring(contentStart, contentStart + len);
    if (type === "updatePanel" && content.includes("<table")) {
      htmlSections.push(content);
    }
    pos = contentStart + len + 1;
  }
  for (const html of htmlSections) {
    const rows = parseHtmlForInfo(html);
    if (rows && rows.length > 0) return rows;
  }
  return null;
}

// Parse plain HTML for address info table
function parseHtmlForInfo(html: string): InfoRow[] | null {
  const stripTags = (s: string) =>
    s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  let best: InfoRow[] = [];

  for (const tableHtml of tableMatches) {
    const lower = tableHtml.toLowerCase();
    let score = 0;
    if (lower.includes("terminal")) score += 2;
    if (lower.includes("address"))  score += 3;
    if (lower.includes("location")) score += 2;
    if (lower.includes("surcharge")) score += 2;
    if (lower.includes("postal"))   score += 2;
    if (score < 4) continue;

    const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    if (rowMatches.length < 2) continue;

    let headerIdx = -1;
    let headers: string[] = [];
    for (let i = 0; i < rowMatches.length; i++) {
      const cellMatches = rowMatches[i].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) ?? [];
      const texts = cellMatches.map(c => stripTags(c).toLowerCase().replace(/\s+/g, ""));
      const joined = texts.join("");
      if ((joined.includes("terminalid") || joined.includes("termid")) &&
          (joined.includes("address") || joined.includes("location") || joined.includes("surcharge"))) {
        headerIdx = i; headers = texts; break;
      }
    }
    if (headerIdx < 0) continue;

    const col = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));
    const iTermId   = col("terminalid") >= 0 ? col("terminalid") : col("termid") >= 0 ? col("termid") : 0;
    const iLocation = col("locationname") >= 0 ? col("locationname") : col("location") >= 0 ? col("location") : -1;
    const iAddress  = col("address");
    const iCity     = col("city");
    const iState    = col("state") >= 0 ? col("state") : col("province");
    const iPostal   = col("postal") >= 0 ? col("postal") : col("zip");
    const iProp     = col("propertytype") >= 0 ? col("propertytype") : col("property") >= 0 ? col("property") : -1;
    const iMake     = col("machinetype") >= 0 ? col("machinetype") : col("makemodel") >= 0 ? col("makemodel") : col("make") >= 0 ? col("make") : -1;
    const iSurch    = col("surcharge") >= 0 ? col("surcharge") : col("fee") >= 0 ? col("fee") : -1;

    const parseDollar = (s: string): number | null => {
      const n = parseFloat(s.replace(/[$,\s]/g, "")); return isNaN(n) ? null : n;
    };

    const rows: InfoRow[] = [];
    for (let i = headerIdx + 1; i < rowMatches.length; i++) {
      const cellMatches = rowMatches[i].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) ?? [];
      const cells = cellMatches.map(c => stripTags(c));
      if (cells.length < 2) continue;
      const terminalId = cells[iTermId] ?? "";
      if (!terminalId || /^total|^grand|^sub/i.test(terminalId) || terminalId.length > 20) continue;
      const g = (ix: number) => (ix >= 0 && cells[ix] ? cells[ix].trim() || null : null);
      rows.push({
        terminalId,
        locationName: g(iLocation),
        address:      g(iAddress),
        city:         g(iCity),
        state:        g(iState),
        postalCode:   g(iPostal),
        propertyType: g(iProp),
        makeModel:    g(iMake),
        surcharge:    iSurch >= 0 ? parseDollar(cells[iSurch] ?? "") : null,
      });
    }
    if (rows.length > best.length) best = rows;
  }
  return best.length > 0 ? best : null;
}

// ---------------------------------------------------------------------------
// CSV export for the info report (terminal list)
// ---------------------------------------------------------------------------

async function tryInfoCSVExport(
  page: Page,
  controlId: string,
  reportName: string,
): Promise<InfoRow[] | null> {
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

    logger.debug({ reportName, exportUrl }, "Columbus Data: trying CSV export for info");
    const response = await page.goto(exportUrl, { waitUntil: "domcontentloaded" });
    if (!response || !response.ok()) {
      logger.debug({ reportName, status: response?.status() }, "Columbus Data: CSV info export failed");
      return null;
    }

    const csvText = await response.text();
    if (!csvText || csvText.trim().length < 20) return null;

    return parseInfoCSV(csvText);
  } catch (err) {
    logger.debug({ reportName, err: (err as Error).message }, "Columbus Data: CSV info export error");
    return null;
  }
}

function parseInfoCSV(csv: string): InfoRow[] {
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
  const col = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));

  const iTermId   = col("terminalid") >= 0 ? col("terminalid") : col("termid") >= 0 ? col("termid") : 0;
  const iLocation = col("locationname") >= 0 ? col("locationname") : col("location") >= 0 ? col("location") : -1;
  const iAddress  = col("address");
  const iCity     = col("city");
  const iState    = col("state") >= 0 ? col("state") : col("province");
  const iPostal   = col("postal") >= 0 ? col("postal") : col("zip");
  const iProp     = col("propertytype") >= 0 ? col("propertytype") : col("property") >= 0 ? col("property") : -1;
  const iMake     = col("machinetype") >= 0 ? col("machinetype") : col("makemodel") >= 0 ? col("makemodel") : col("make") >= 0 ? col("make") : -1;
  const iSurch    = col("surcharge") >= 0 ? col("surcharge") : col("fee") >= 0 ? col("fee") : -1;

  const parseDollar = (s: string): number | null => {
    const n = parseFloat(s.replace(/[$,\s]/g, ""));
    return isNaN(n) ? null : n;
  };

  const result: InfoRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (cells.length < 2) continue;
    const terminalId = cells[iTermId]?.trim() ?? "";
    if (!terminalId || /^total|^grand|^sub/i.test(terminalId) || terminalId.length > 20) continue;

    const g = (idx: number) => (idx >= 0 && cells[idx] ? cells[idx].trim() || null : null);
    result.push({
      terminalId,
      locationName: g(iLocation),
      address:      g(iAddress),
      city:         g(iCity),
      state:        g(iState),
      postalCode:   g(iPostal),
      propertyType: g(iProp),
      makeModel:    g(iMake),
      surcharge:    iSurch >= 0 ? parseDollar(cells[iSurch] ?? "") : null,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Table extraction — runs inside a single frame context
// ---------------------------------------------------------------------------

async function extractTableFromFrame(
  frame: Frame,
  reportName: string,
  frameUrl: string,
): Promise<InfoRow[] | null> {
  return frame.evaluate((rn: string, fu: string) => {
    function cellText(el: Element | null): string {
      return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    function parseDollar(raw: string): number | null {
      const n = parseFloat(raw.replace(/[$,\s]/g, ""));
      return isNaN(n) ? null : n;
    }

    // ── Find the best candidate table ─────────────────────────────────────
    const tables = Array.from(document.querySelectorAll("table"));

    // Score tables: prefer those with "terminal" + at least one address-like keyword
    let bestTable: HTMLTableElement | null = null;
    let bestScore = 0;

    for (const t of tables) {
      if (t.rows.length < 2) continue;
      const text = (t.textContent ?? "").toLowerCase();
      let score = 0;
      if (text.includes("terminal"))  score += 2;
      if (text.includes("location"))  score += 2;
      if (text.includes("address"))   score += 3;
      if (text.includes("surcharge")) score += 2;
      if (text.includes("postal"))    score += 2;
      if (text.includes("property"))  score += 2;
      if (text.includes("city"))      score += 1;
      if (score > bestScore && t.rows.length > bestScore) {
        bestScore = score;
        bestTable = t;
      }
    }

    if (!bestTable || bestScore < 3) return null;

    // ── Find the header row ───────────────────────────────────────────────
    const allRows = Array.from(bestTable.querySelectorAll("tr"));
    const headerRow = allRows.find(r => {
      const t = (r.textContent ?? "").toLowerCase().replace(/\s+/g, "");
      return (t.includes("terminalid") || t.includes("termid")) &&
             (t.includes("address") || t.includes("location") || t.includes("surcharge") ||
              t.includes("postal") || t.includes("property") || t.includes("city"));
    });

    if (!headerRow) return null;

    const headers = Array.from(headerRow.querySelectorAll("th, td"))
      .map(h => cellText(h).toLowerCase().replace(/\s+/g, ""));

    function col(keyword: string): number {
      const k = keyword.toLowerCase().replace(/\s+/g, "");
      const idx = headers.findIndex(h => h.includes(k));
      return idx;
    }

    // Map all relevant columns
    const iTermId     = col("terminalid") >= 0 ? col("terminalid") : col("termid") >= 0 ? col("termid") : 0;
    const iLocation   = col("locationname") >= 0 ? col("locationname") : col("location") >= 0 ? col("location") : -1;
    const iAddress    = col("address");
    const iCity       = col("city");
    const iState      = col("state") >= 0 ? col("state") : col("province");
    const iPostal     = col("postal") >= 0 ? col("postal") : col("zip");
    const iPropType   = col("propertytype") >= 0 ? col("propertytype") : col("property") >= 0 ? col("property") : col("type") >= 0 ? col("type") : -1;
    const iMakeModel  = col("machinetype") >= 0 ? col("machinetype") : col("makemodel") >= 0 ? col("makemodel") : col("model") >= 0 ? col("model") : col("make") >= 0 ? col("make") : -1;
    const iSurcharge  = col("surcharge") >= 0 ? col("surcharge") : col("fee") >= 0 ? col("fee") : -1;

    const headerIdx = allRows.indexOf(headerRow);
    const result: InfoRow[] = [];

    for (let i = headerIdx + 1; i < allRows.length; i++) {
      const cells = Array.from(allRows[i].querySelectorAll("td"));
      if (cells.length < 2) continue;

      const terminalId = cellText(cells[iTermId] ?? cells[0]);
      if (!terminalId || /terminal\s*id|^total|^grand|^sub/i.test(terminalId) || terminalId.length > 20) continue;

      function getCell(idx: number): string | null {
        if (idx < 0 || idx >= cells.length) return null;
        return cellText(cells[idx]) || null;
      }

      result.push({
        terminalId,
        locationName: getCell(iLocation),
        address:      getCell(iAddress),
        city:         getCell(iCity),
        state:        getCell(iState),
        postalCode:   getCell(iPostal),
        propertyType: getCell(iPropType),
        makeModel:    getCell(iMakeModel),
        surcharge:    iSurcharge >= 0 ? parseDollar(cellText(cells[iSurcharge])) : null,
      });
    }

    return result.length > 0 ? result : null;
  }, reportName, frameUrl) as Promise<InfoRow[] | null>;
}

// ---------------------------------------------------------------------------
// Status grid scraper — terminal IDs, balance, last contact
// ---------------------------------------------------------------------------

interface GridRow {
  terminalId: string;
  terminalLabel: string;
  currentBalance: number | null;
  lastContact: string | null;
  isOnline: boolean;
}

async function scrapeStatusGrid(page: Page): Promise<GridRow[]> {
  const rows: GridRow[] = [];
  let pageNum = 1;

  while (true) {
    logger.info({ pageNum }, "Columbus Data: scraping grid page");

    const pageRows = await page.evaluate(() => {
      function cellText(cell: Element): string {
        return (cell.textContent || "").replace(/\s+/g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }

      const table = document.querySelector("table[id*='rgTermStatusReport_ctl00']") as HTMLTableElement | null;
      if (!table) return [];

      const headerRow = table.querySelector("thead tr, tr.rgHeader");
      const headers: string[] = [];
      if (headerRow) {
        headerRow.querySelectorAll("th, td").forEach(th => headers.push(cellText(th).toLowerCase()));
      }

      const idxOf = (kw: string) => headers.findIndex(h => h.replace(/\s+/g, "").includes(kw.replace(/\s+/g, "")));
      const termIdIdx      = idxOf("terminalid") !== -1 ? idxOf("terminalid") : 0;
      const nameIdx        = idxOf("name") !== -1 ? idxOf("name") : 1;
      const balanceIdx     = idxOf("cashbalance") !== -1 ? idxOf("cashbalance") : idxOf("balance") !== -1 ? idxOf("balance") : 3;
      const lastContactIdx = idxOf("lastcommunication") !== -1 ? idxOf("lastcommunication")
                           : idxOf("communication")    !== -1 ? idxOf("communication")
                           : idxOf("lastcontact")      !== -1 ? idxOf("lastcontact") : -1;

      const result: { terminalId: string; terminalLabel: string; currentBalance: number | null; lastContact: string | null; isOnline: boolean }[] = [];

      table.querySelectorAll("tr.rgRow, tr.rgAltRow").forEach(tr => {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length < 2) return;
        const terminalId = cellText(cells[termIdIdx] ?? cells[0]);
        if (!terminalId || terminalId === "Terminal ID") return;

        const name          = cells[nameIdx] ? cellText(cells[nameIdx]) : "";
        const terminalLabel = name ? `${terminalId} - ${name}` : terminalId;
        const currentBalance = parseDollar(cells[balanceIdx] ? cellText(cells[balanceIdx]) : "");
        const lastContact  = lastContactIdx >= 0 && cells[lastContactIdx] ? cellText(cells[lastContactIdx]) : null;

        let isOnline = false;
        if (lastContact) {
          const d = new Date(lastContact);
          if (!isNaN(d.getTime())) isOnline = Date.now() - d.getTime() < 48 * 3_600_000;
        }

        result.push({ terminalId, terminalLabel, currentBalance, lastContact, isOnline });
      });

      return result;
    });

    rows.push(...pageRows);
    logger.info({ pageNum, rowsOnPage: pageRows.length, totalSoFar: rows.length }, "Columbus Data: grid page done");

    const hasNext = await page.evaluate(() => {
      const btn = document.querySelector("a[title='Next Page'], input[title='Next Page'], .rgPageNext:not(.rgPageNextDisabled)");
      if (btn && !(btn as HTMLElement).classList.contains("rgPageNextDisabled")) {
        (btn as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (!hasNext || pageRows.length === 0) break;
    await new Promise(r => setTimeout(r, 2_500));
    pageNum++;
    if (pageNum > 20) break;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Debug: probe the portal for address data from non-SSRS sources
// ---------------------------------------------------------------------------

export async function debugScrapeAddress(
  username: string,
  password: string,
): Promise<Record<string, unknown>> {
  let browser: Browser | null = null;
  const diag: Record<string, unknown> = {};

  const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  try {
    const executablePath = findChromiumExecutable();
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--single-process"],
      executablePath,
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(15_000);

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    // Login
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#UsernameTextbox", { visible: true });
    await page.type("#UsernameTextbox", username, { delay: 30 });
    await page.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#LoginButton"),
    ]);
    diag.afterLoginUrl = page.url();
    if (/login/i.test(page.url())) {
      diag.error = "login failed"; return diag;
    }

    // ── 1. Status grid: check if terminal rows have detail-page links ──────
    await page.goto(GRID_URL, { waitUntil: "load" });
    await sleepMs(2_000);

    diag.gridLinks = await page.evaluate(() => {
      const links: string[] = [];
      document.querySelectorAll("table[id*='rgTermStatusReport'] a[href]").forEach(a => {
        const href = (a as HTMLAnchorElement).href;
        if (href && !links.includes(href)) links.push(href);
      });
      return links.slice(0, 20);
    });

    diag.gridFirstRowHtml = await page.evaluate(() => {
      const row = document.querySelector("table[id*='rgTermStatusReport'] tr.rgRow, table[id*='rgTermStatusReport'] tr.rgAltRow");
      return row ? row.innerHTML.slice(0, 800) : "no row found";
    });

    // ── 2. Probe common terminal-detail URLs ──────────────────────────────
    const FIRST_TERM = "L745870"; // Known good terminal
    const PROBE_URLS = [
      `https://www.columbusdata.net/cdswebtool/TerminalMonitoring/TerminalDetails.aspx?TermID=${FIRST_TERM}`,
      `https://www.columbusdata.net/cdswebtool/TerminalMonitoring/TerminalInfo.aspx?TermID=${FIRST_TERM}`,
      `https://www.columbusdata.net/cdswebtool/QuickView/TerminalDetails.aspx?TermID=${FIRST_TERM}`,
      `https://www.columbusdata.net/cdswebtool/QuickView/TerminalInfo.aspx?TermID=${FIRST_TERM}`,
      `https://www.columbusdata.net/cdswebtool/TerminalManagement/EditTerminal.aspx?TermID=${FIRST_TERM}`,
      `https://www.columbusdata.net/cdswebtool/TerminalManagement/TerminalDetails.aspx?TermID=${FIRST_TERM}`,
      `https://www.columbusdata.net/cdswebtool/Setup/TerminalSetup.aspx?TermID=${FIRST_TERM}`,
    ];

    const probeResults: Record<string, unknown>[] = [];
    for (const probeUrl of PROBE_URLS) {
      try {
        await page.goto(probeUrl, { waitUntil: "load", timeout: 12_000 });
        const finalUrl = page.url();
        const bodySnippet = await page.evaluate(() =>
          (document.body?.innerText ?? "").slice(0, 400).replace(/\s+/g, " ").trim()
        ).catch(() => "");
        const has404 = /404|not found|error/i.test(bodySnippet) || finalUrl.includes("404") || finalUrl.includes("Error");
        probeResults.push({ url: probeUrl, finalUrl, has404, bodySnippet });
        if (!has404 && finalUrl === probeUrl) break; // Found a working page
      } catch (e) {
        probeResults.push({ url: probeUrl, error: (e as Error).message });
      }
    }
    diag.probeResults = probeResults;

    // ── 3. Check portal home page nav links ───────────────────────────────
    try {
      const homeUrl = "https://www.columbusdata.net/cdswebtool/";
      await page.goto(homeUrl, { waitUntil: "load", timeout: 10_000 });
      diag.homeUrl = page.url();
      diag.homeNavLinks = await page.evaluate(() => {
        const links: string[] = [];
        document.querySelectorAll("a[href]").forEach(a => {
          const href = (a as HTMLAnchorElement).href;
          if (href && href.includes("columbusdata") && !links.includes(href)) links.push(href);
        });
        return links.slice(0, 30);
      });
    } catch (e) {
      diag.homeError = (e as Error).message;
    }

    // ── 4. Try clicking the first terminal row to see where it goes ───────
    try {
      await page.goto(GRID_URL, { waitUntil: "load", timeout: 15_000 });
      await sleepMs(1_500);
      const clicked = await page.evaluate(() => {
        const firstRow = document.querySelector("table[id*='rgTermStatusReport'] tr.rgRow, table[id*='rgTermStatusReport'] tr.rgAltRow");
        if (!firstRow) return "no row";
        const link = firstRow.querySelector("a");
        if (link) { (link as HTMLAnchorElement).click(); return "clicked link: " + (link as HTMLAnchorElement).href; }
        (firstRow as HTMLElement).click();
        return "clicked row";
      });
      diag.gridRowClickResult = clicked;
      await sleepMs(2_000);
      diag.afterRowClickUrl = page.url();
      diag.afterRowClickBodySnippet = await page.evaluate(() =>
        (document.body?.innerText ?? "").slice(0, 600).replace(/\s+/g, " ").trim()
      ).catch(() => "");
    } catch (e) {
      diag.gridRowClickError = (e as Error).message;
    }

  } finally {
    await browser?.close().catch(() => {});
  }

  return diag;
}
