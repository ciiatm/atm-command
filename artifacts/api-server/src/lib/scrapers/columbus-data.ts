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

import puppeteer, { type Browser, type Page, type Frame } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL        = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const GRID_URL         = "https://www.columbusdata.net/cdswebtool/QuickView/TerminalStatusReport.aspx";
const TERM_LIST_URL    = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptTerminalListType";
const ACTIVE_TERMS_URL = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptActiveTerminals";

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
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(30_000);

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

  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});

  // Give the page time to start rendering
  await new Promise(r => setTimeout(r, 2_000));

  // Click any "View Report" / "Submit" / "Run" button
  const clicked = await page.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll<HTMLElement>("input[type=submit], input[type=button], button")
    ).find(el => /view|submit|run|generate|report/i.test(
      (el as HTMLInputElement).value || (el as HTMLButtonElement).textContent || ""
    ));
    if (btn) { btn.click(); return (btn as HTMLInputElement).value || (btn as HTMLButtonElement).textContent || "clicked"; }
    return null;
  }).catch(() => null);

  if (clicked) {
    logger.info({ reportName, clicked }, "Columbus Data: clicked submit button");
    await new Promise(r => setTimeout(r, 3_000));
  }

  // Poll all frames (main + iframes) for up to 30 s
  const deadline = Date.now() + 30_000;
  let bestRows: InfoRow[] = [];

  while (Date.now() < deadline) {
    const allFrames: Frame[] = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];

    logger.info({ reportName, frameCount: allFrames.length }, "Columbus Data: scanning frames");

    for (const frame of allFrames) {
      let frameUrl = "";
      try { frameUrl = frame.url(); } catch { continue; }

      const rows = await extractTableFromFrame(frame, reportName, frameUrl).catch(() => null);

      if (rows && rows.length > 0) {
        logger.info({ reportName, frameUrl, rowCount: rows.length, sample: rows[0] }, "Columbus Data: found report rows");
        if (rows.length > bestRows.length) bestRows = rows;
      }
    }

    if (bestRows.length > 0) break;

    // Not found yet — wait and retry
    await new Promise(r => setTimeout(r, 3_000));
  }

  if (bestRows.length === 0) {
    // Log a diagnostic snippet from the main frame
    const snippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "");
    logger.warn({ reportName, bodySnippet: snippet }, "Columbus Data: no rows found in any frame after 30s");
  }

  const map = new Map<string, InfoRow>();
  for (const row of bestRows) {
    if (row.terminalId) map.set(row.terminalId, row);
  }
  return map;
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
