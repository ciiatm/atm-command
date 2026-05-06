/**
 * Columbus Data Portal Scraper — ATM Info & Status
 *
 * Strategy:
 * 1. Login
 * 2. Scrape TerminalStatusReport.aspx grid — terminal IDs, balance, last contact (FAST)
 * 3. Scrape rptTerminalListType report — postal code, property type, and any extra fields
 * 4. Scrape rptActiveTerminals report — location name, address, city, state, make/model, surcharge
 * 5. Merge all three sources by terminal ID and return
 *
 * Steps 3 and 4 both run against ReportViewer.aspx pages (bulk tables, fast).
 * No per-terminal navigation required.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL        = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const REPORT_URL       = "https://www.columbusdata.net/cdswebtool/QuickView/TerminalStatusReport.aspx";
const ACTIVE_TERMS_URL = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptActiveTerminals";
const TERM_LIST_URL    = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptTerminalListType";

export interface ColumbusTerminalStatus {
  terminalId: string;
  terminalLabel: string;
  // From rptActiveTerminals
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  makeModel: string | null;
  surcharge: number | null;
  // From rptTerminalListType
  postalCode: string | null;
  propertyType: string | null;
  // From TerminalStatusReport grid
  currentBalance: number | null;
  lastContact: string | null;
  isOnline: boolean;
}

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

    // ------------------------------------------------------------------
    // Step 1: Login
    // ------------------------------------------------------------------
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
      throw new Error("Columbus Data login failed — still on login page, check credentials");
    }
    logger.info("Columbus Data: login successful");

    // ------------------------------------------------------------------
    // Step 2: TerminalStatusReport grid — balance, last contact, IDs (FAST)
    // ------------------------------------------------------------------
    logger.info("Columbus Data: navigating to terminal status grid");
    page.goto(REPORT_URL).catch(() => {});

    const gridFound = await page
      .waitForSelector("table[id*='rgTermStatusReport']", { timeout: 45_000 })
      .then(() => true).catch(() => false);

    if (!gridFound) {
      const html = await page.evaluate(() => document.body?.innerHTML?.slice(0, 2000) ?? "");
      logger.warn({ html }, "Columbus Data: grid not found");
      throw new Error("Columbus Data: status report grid not found after 45s");
    }

    // Try to expand page size to get all terminals on one page
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
      throw new Error("Columbus Data: no terminal rows found in status report grid");
    }

    // ------------------------------------------------------------------
    // Step 3: rptTerminalListType — postal code, property type, extra info
    // ------------------------------------------------------------------
    const terminalListMap = await scrapeReportTable(page, TERM_LIST_URL, "rptTerminalListType");
    logger.info({ count: terminalListMap.size }, "Columbus Data: rptTerminalListType scraped");

    // ------------------------------------------------------------------
    // Step 4: rptActiveTerminals — location name, address, city, state, make/model, surcharge
    // ------------------------------------------------------------------
    const activeTerminalsMap = await scrapeReportTable(page, ACTIVE_TERMS_URL, "rptActiveTerminals");
    logger.info({ count: activeTerminalsMap.size }, "Columbus Data: rptActiveTerminals scraped");

    // ------------------------------------------------------------------
    // Step 5: Merge and return
    // ------------------------------------------------------------------
    const results: ColumbusTerminalStatus[] = gridRows.map(row => {
      const active = activeTerminalsMap.get(row.terminalId);
      const listType = terminalListMap.get(row.terminalId);

      // Prefer terminalListType for postal code / property type;
      // fall back to activeTerminals if terminalListType didn't have them
      const postalCode   = listType?.postalCode   ?? active?.postalCode   ?? null;
      const propertyType = listType?.propertyType ?? active?.propertyType ?? null;

      return {
        terminalId: row.terminalId,
        terminalLabel: row.terminalLabel,
        locationName: active?.locationName ?? listType?.locationName ?? null,
        address:      active?.address      ?? listType?.address      ?? null,
        city:         active?.city         ?? listType?.city         ?? null,
        state:        active?.state        ?? listType?.state        ?? null,
        makeModel:    active?.makeModel    ?? listType?.makeModel    ?? null,
        surcharge:    active?.surcharge    ?? listType?.surcharge    ?? null,
        postalCode,
        propertyType,
        currentBalance: row.currentBalance,
        lastContact:    row.lastContact,
        isOnline:       row.isOnline,
      };
    });

    // Deduplicate by terminal ID
    const seen = new Set<string>();
    const deduped = results.filter(r => {
      if (seen.has(r.terminalId)) return false;
      seen.add(r.terminalId);
      return true;
    });

    logger.info({ scraped: results.length, deduped: deduped.length }, "Columbus Data: sync complete");
    return deduped;

  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Generic ReportViewer.aspx table scraper
// Handles both rptActiveTerminals and rptTerminalListType (same page structure)
// Returns a Map<terminalId, record> with all columns keyed by lowercase header
// ---------------------------------------------------------------------------

interface ReportRow {
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

async function scrapeReportTable(
  page: Page,
  url: string,
  reportName: string,
): Promise<Map<string, ReportRow>> {
  logger.info({ url }, `Columbus Data: scraping ${reportName}`);

  // Proper await navigation — avoids race condition with waitForSelector
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});

  // Wait for any table to appear
  await page.waitForSelector("table", { timeout: 20_000 }).catch(() => {});

  // Click a View Report / Submit / Run button if present (needed for ReportViewer.aspx)
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll<HTMLElement>(
      "input[type=submit], button, input[type=button]"
    )).find(el => /view|submit|run|generate|get/i.test(
      (el as HTMLInputElement).value ?? (el as HTMLButtonElement).innerText ?? ""
    ));
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);

  if (clicked) {
    // Wait for the report table to reload after clicking
    await new Promise(r => setTimeout(r, 1_000));
    await page.waitForSelector("table", { timeout: 25_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1_500));
  }

  // Scrape the table — try main frame then iframes
  const scrapeTable = async (ctx: Page | import("puppeteer").Frame): Promise<ReportRow[] | null> => {
    return ctx.evaluate(() => {
      function cellText(el: Element): string {
        return (el.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }

      // Find the largest table that mentions "terminal"
      const tables = Array.from(document.querySelectorAll("table"));
      let best: HTMLTableElement | null = null;
      for (const t of tables) {
        const text = (t.textContent ?? "").toLowerCase();
        if (t.rows.length > 3 && (text.includes("terminal") || text.includes("location") || text.includes("property"))) {
          if (!best || t.rows.length > best.rows.length) best = t;
        }
      }
      if (!best) return null;

      // Find the header row — look for a row with at least 3 th/td headers
      const allRows = Array.from(best.querySelectorAll("tr"));
      const headerRow = allRows.find(r => {
        const t = (r.textContent ?? "").toLowerCase().replace(/\s+/g, "");
        return t.includes("terminal") && (
          t.includes("address") || t.includes("location") || t.includes("postal") ||
          t.includes("property") || t.includes("surcharge") || t.includes("city") ||
          t.includes("type")
        );
      });
      if (!headerRow) return null;

      const headers = Array.from(headerRow.querySelectorAll("th, td"))
        .map(h => cellText(h).toLowerCase().replace(/\s+/g, ""));

      function colIdx(keyword: string): number {
        const k = keyword.toLowerCase().replace(/\s+/g, "");
        return headers.findIndex(h => h.includes(k));
      }

      const idxTerminal   = colIdx("terminalid") >= 0 ? colIdx("terminalid") : colIdx("termid") >= 0 ? colIdx("termid") : 0;
      const idxLocation   = colIdx("locationname") >= 0 ? colIdx("locationname") : colIdx("location") >= 0 ? colIdx("location") : -1;
      const idxAddress    = colIdx("address");
      const idxCity       = colIdx("city");
      const idxState      = colIdx("state") >= 0 ? colIdx("state") : colIdx("province");
      const idxPostal     = colIdx("postal") >= 0 ? colIdx("postal") : colIdx("zip");
      const idxPropType   = colIdx("propertytype") >= 0 ? colIdx("propertytype") : colIdx("property") >= 0 ? colIdx("property") : colIdx("type") >= 0 ? colIdx("type") : -1;
      const idxMakeModel  = colIdx("machinetype") >= 0 ? colIdx("machinetype") : colIdx("makemodel") >= 0 ? colIdx("makemodel") : colIdx("model") >= 0 ? colIdx("model") : colIdx("make") >= 0 ? colIdx("make") : -1;
      const idxSurcharge  = colIdx("surcharge");

      const result: {
        terminalId: string;
        locationName: string | null; address: string | null; city: string | null;
        state: string | null; postalCode: string | null; propertyType: string | null;
        makeModel: string | null; surcharge: number | null;
      }[] = [];

      const headerIdx = allRows.indexOf(headerRow);
      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const cells = Array.from(allRows[i].querySelectorAll("td"));
        if (cells.length < 2) continue;

        const terminalId = cellText(cells[idxTerminal] ?? cells[0]);
        if (!terminalId || /terminal\s*id|^total|^grand/i.test(terminalId)) continue;

        function getCell(idx: number): string | null {
          if (idx < 0 || idx >= cells.length) return null;
          return cellText(cells[idx]) || null;
        }

        result.push({
          terminalId,
          locationName: getCell(idxLocation),
          address:      getCell(idxAddress),
          city:         getCell(idxCity),
          state:        getCell(idxState),
          postalCode:   getCell(idxPostal),
          propertyType: getCell(idxPropType),
          makeModel:    getCell(idxMakeModel),
          surcharge:    idxSurcharge >= 0 && cells[idxSurcharge] ? parseDollar(cellText(cells[idxSurcharge])) : null,
        });
      }

      return result.length > 0 ? result : null;
    });
  };

  let rows = await scrapeTable(page).catch(() => null);

  // Try iframes if main frame had no results
  if (!rows || rows.length === 0) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      rows = await scrapeTable(frame as any).catch(() => null);
      if (rows && rows.length > 0) break;
    }
  }

  logger.info(
    { report: reportName, count: rows?.length ?? 0, sample: rows?.[0] ?? null },
    "Columbus Data: report table scraped"
  );

  const map = new Map<string, ReportRow>();
  for (const row of rows ?? []) {
    if (row.terminalId) {
      map.set(row.terminalId, row);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// TerminalStatusReport.aspx grid — terminal IDs, balance, last contact
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
        return (cell.textContent || "").replace(/ /g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }

      const table = document.querySelector("table[id*='rgTermStatusReport_ctl00']") as HTMLTableElement | null;
      if (!table) return [];

      const result: {
        terminalId: string; terminalLabel: string; currentBalance: number | null;
        lastContact: string | null; isOnline: boolean;
      }[] = [];

      const headerRow = table.querySelector("thead tr, tr.rgHeader");
      const headers: string[] = [];
      if (headerRow) {
        headerRow.querySelectorAll("th, td").forEach(th => {
          headers.push(cellText(th).toLowerCase());
        });
      }

      const idxOf = (keyword: string) =>
        headers.findIndex(h => h.replace(/\s+/g, "").includes(keyword.replace(/\s+/g, "")));

      const termIdIdx      = idxOf("terminalid") !== -1 ? idxOf("terminalid") : 0;
      const nameIdx        = idxOf("name") !== -1 ? idxOf("name") : 1;
      const balanceIdx     = idxOf("cashbalance") !== -1 ? idxOf("cashbalance")
                           : idxOf("balance")    !== -1 ? idxOf("balance") : 3;
      const lastContactIdx = idxOf("lastcommunication") !== -1 ? idxOf("lastcommunication")
                           : idxOf("communication")    !== -1 ? idxOf("communication")
                           : idxOf("lastcontact")      !== -1 ? idxOf("lastcontact") : -1;

      table.querySelectorAll("tr.rgRow, tr.rgAltRow").forEach(tr => {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length < 2) return;

        const terminalId = cellText(cells[termIdIdx] ?? cells[0]);
        if (!terminalId || terminalId === "Terminal ID") return;

        const name          = cells[nameIdx] ? cellText(cells[nameIdx]) : "";
        const terminalLabel = name ? `${terminalId} - ${name}` : terminalId;
        const balanceRaw    = cells[balanceIdx] ? cellText(cells[balanceIdx]) : "";
        const currentBalance = parseDollar(balanceRaw);
        const lastContact   = lastContactIdx >= 0 && cells[lastContactIdx]
          ? cellText(cells[lastContactIdx]) : null;

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
    logger.info({ pageNum, rowsOnPage: pageRows.length, totalSoFar: rows.length }, "Columbus Data: grid page scraped");

    const hasNext = await page.evaluate(() => {
      const nextBtn = document.querySelector(
        "a[title='Next Page'], input[title='Next Page'], .rgPageNext:not(.rgPageNextDisabled)"
      );
      if (nextBtn && !(nextBtn as HTMLElement).classList.contains("rgPageNextDisabled")) {
        (nextBtn as HTMLElement).click();
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
