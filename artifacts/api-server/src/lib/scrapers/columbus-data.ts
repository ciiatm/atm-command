/**
 * Columbus Data Portal Scraper
 *
 * Strategy:
 * 1. Login to the portal
 * 2. Open a second browser page and start loading wrptTermDaily (transactions) in background
 * 3. Scrape the Active Terminals report — address, location name, machine type, surcharge
 * 4. Scrape the Terminal Status Report grid — balance, last contact, online status
 * 5. Wait for the daily report to finish, then merge transactions into results
 *
 * Requires: puppeteer
 * On EC2/Linux: google-chrome-stable (non-snap) must be installed.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const REPORT_URL = "https://www.columbusdata.net/cdswebtool/QuickView/TerminalStatusReport.aspx";
const ACTIVE_TERMINALS_URL = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptActiveTerminals";
const TERM_DAILY_URL = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=wrptTermDaily";

export interface ColumbusTransaction {
  transactedAt: string;
  cardNumber: string | null;
  transactionType: string | null;
  amount: number | null;
  response: string | null;
  terminalBalance: number | null;
}

export interface ColumbusTerminalStatus {
  terminalId: string;
  terminalLabel: string;
  // From the Active Terminals report
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  makeModel: string | null;
  surcharge: number | null;
  // From the Status Report grid
  currentBalance: number | null;
  lastContact: string | null;
  dailyCashDispensed: number | null;
  dailyTransactionCount: number | null;
  isOnline: boolean;
  transactions: ColumbusTransaction[];
}

// Info pulled from the Active Terminals report
interface ActiveTerminalInfo {
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  makeModel: string | null;
  surcharge: number | null;
}

// ---------------------------------------------------------------------------
// Chromium detection
// ---------------------------------------------------------------------------

function findChromiumExecutable(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
  for (const bin of candidates) {
    try {
      const p = execSync(`which ${bin} 2>/dev/null`).toString().trim();
      if (p) {
        logger.info({ path: p }, "Columbus Data: found system Chromium");
        return p;
      }
    } catch { /* try next */ }
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

    const afterLoginUrl = page.url();
    logger.info({ afterLoginUrl }, "Columbus Data: after login");
    if (/login|Login/i.test(afterLoginUrl)) {
      throw new Error("Columbus Data login failed — still on login page, check credentials");
    }

    // ------------------------------------------------------------------
    // Step 2: Open a second page and kick off the daily transaction report
    // in the background so it loads while we do everything else.
    // ------------------------------------------------------------------
    const txPage = await browser.newPage();
    txPage.setDefaultNavigationTimeout(60_000);
    txPage.setDefaultTimeout(30_000);
    // Fire-and-forget — we'll await the parsed result later
    const txReportPromise = scrapeTermDailyReport(txPage).catch(err => {
      logger.warn({ err: err?.message }, "Columbus Data: daily transaction report failed, skipping");
      return new Map<string, ColumbusTransaction[]>();
    });

    // ------------------------------------------------------------------
    // Step 3: Scrape the Active Terminals report for location/address info
    // ------------------------------------------------------------------
    const activeTerminalsMap = await scrapeActiveTerminalsReport(page);
    logger.info({ count: activeTerminalsMap.size }, "Columbus Data: active terminals report done");

    // ------------------------------------------------------------------
    // Step 4: Scrape the Terminal Status Report grid (balance / online status)
    // ------------------------------------------------------------------
    logger.info({ url: REPORT_URL }, "Columbus Data: navigating to status report grid");
    page.goto(REPORT_URL).catch(() => {});

    // Wait for the Telerik RadGrid table to appear
    const gridFound = await page
      .waitForSelector("table[id*='rgTermStatusReport']", { timeout: 45_000 })
      .then(() => true).catch(() => false);

    logger.info({ gridFound }, "Columbus Data: status report grid loaded");
    if (!gridFound) {
      const html = await page.evaluate(() => document.body?.innerHTML?.slice(0, 2000) ?? "");
      logger.warn({ html }, "Columbus Data: grid not found");
      throw new Error("Columbus Data: status report grid not found after 45s");
    }

    // Try to set page size to 100 so we get more terminals per page
    await setGridPageSize(page, 100);

    // Scrape all rows from the grid (handles multiple pages)
    const gridRows = await scrapeStatusReportGrid(page);
    logger.info({ count: gridRows.length }, "Columbus Data: scraped terminal grid rows");

    if (gridRows.length === 0) {
      throw new Error("Columbus Data: no terminal rows found in status report grid");
    }

    // ------------------------------------------------------------------
    // Step 5: Wait for the daily transaction report, then merge everything
    // ------------------------------------------------------------------
    const txMap = await txReportPromise;
    logger.info({ terminalsWithTx: txMap.size }, "Columbus Data: transaction report merged");

    const results: ColumbusTerminalStatus[] = gridRows.map(row => {
      const info = activeTerminalsMap.get(row.terminalId);
      return {
        ...row,
        locationName: info?.locationName ?? null,
        address: info?.address ?? null,
        city: info?.city ?? null,
        state: info?.state ?? null,
        makeModel: info?.makeModel ?? row.makeModel,
        surcharge: info?.surcharge ?? null,
        transactions: txMap.get(row.terminalId) ?? [],
      };
    });

    // Deduplicate by terminalId — the grid can return the same terminal on
    // multiple pages if a filter or page-size change causes a partial reload.
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
// Terminal Daily report scraping (ReportViewer.aspx?reportname=wrptTermDaily)
// Gives us: per-terminal transaction rows (date, card, type, amount, response, balance)
// ---------------------------------------------------------------------------

async function scrapeTermDailyReport(page: Page): Promise<Map<string, ColumbusTransaction[]>> {
  logger.info({ url: TERM_DAILY_URL }, "Columbus Data: navigating to terminal daily report");

  page.goto(TERM_DAILY_URL).catch(() => {});

  // Wait up to 25s for any table to appear
  const tableAppeared = await page.waitForSelector("table", { timeout: 25_000 })
    .then(() => true).catch(() => false);

  // Try clicking a "View Report" / submit button whether or not a table appeared —
  // the initial load sometimes renders a parameter form before showing data
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll<HTMLElement>(
      "input[type=submit], button, input[type=button]"
    )).find(el =>
      /view|submit|run|generate|report/i.test(
        (el as HTMLInputElement).value ?? (el as HTMLButtonElement).innerText ?? ""
      )
    );
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);

  if (clicked || !tableAppeared) {
    // Wait for data to load after button click, or for first table if none appeared yet
    await page.waitForSelector("table", { timeout: 25_000 }).catch(() => {});
    // Give the report render a moment to fully populate rows
    await new Promise(r => setTimeout(r, 3_000));
  }

  // Helper: scrape transaction rows from a page/frame context
  const parseTxTable = async (ctx: Page | import("puppeteer").Frame) => {
    return ctx.evaluate(() => {
      function cellText(el: Element): string {
        return (el.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }

      // Pick the table that looks most like a transaction list
      const tables = Array.from(document.querySelectorAll("table"));
      let best: HTMLTableElement | null = null;
      for (const t of tables) {
        const text = (t.textContent ?? "").toLowerCase();
        const hasAmountOrCard = text.includes("amount") || text.includes("card");
        const hasDateOrTime = text.includes("date") || text.includes("time");
        if (hasAmountOrCard && hasDateOrTime && t.rows.length > 2) {
          if (!best || t.rows.length > best.rows.length) best = t;
        }
      }
      if (!best) return null;

      const allRows = Array.from(best.querySelectorAll("tr"));

      // Find the header row
      const headerRow = allRows.find(r => {
        const t = (r.textContent ?? "").toLowerCase().replace(/\s+/g, "");
        return (t.includes("amount") || t.includes("card")) && (t.includes("date") || t.includes("time"));
      });
      if (!headerRow) return null;

      const headers = Array.from(headerRow.querySelectorAll("th, td"))
        .map(h => cellText(h).toLowerCase());

      const idx = (kw: string) => {
        const n = kw.replace(/\s+/g, "");
        return headers.findIndex(h => h.replace(/\s+/g, "").includes(n));
      };

      // Map known column names — fall back to positional guesses
      const termIdIdx    = idx("terminalid") !== -1 ? idx("terminalid")
                         : idx("termid")     !== -1 ? idx("termid")
                         : idx("terminal")   !== -1 ? idx("terminal") : -1;
      const dateIdx      = idx("date")  !== -1 ? idx("date")
                         : idx("time")  !== -1 ? idx("time")  : 0;
      const cardIdx      = idx("card")  !== -1 ? idx("card")  : -1;
      const typeIdx      = idx("transactiontype") !== -1 ? idx("transactiontype")
                         : idx("type")            !== -1 ? idx("type") : -1;
      const amountIdx    = idx("amount")   !== -1 ? idx("amount")   : -1;
      const responseIdx  = idx("response") !== -1 ? idx("response")
                         : idx("status")   !== -1 ? idx("status") : -1;
      const balanceIdx   = idx("balance")  !== -1 ? idx("balance")  : -1;

      const result: {
        terminalId: string | null;
        transactedAt: string;
        cardNumber: string | null;
        transactionType: string | null;
        amount: number | null;
        response: string | null;
        terminalBalance: number | null;
      }[] = [];

      const headerIdx = allRows.indexOf(headerRow);
      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const cells = Array.from(allRows[i].querySelectorAll("td"));
        if (cells.length < 2) continue;
        const dateRaw = cells[dateIdx] ? cellText(cells[dateIdx]) : "";
        if (!dateRaw) continue;

        result.push({
          terminalId: termIdIdx >= 0 && cells[termIdIdx] ? cellText(cells[termIdIdx]) || null : null,
          transactedAt: dateRaw,
          cardNumber:   cardIdx >= 0 && cells[cardIdx]     ? cellText(cells[cardIdx])     || null : null,
          transactionType: typeIdx >= 0 && cells[typeIdx]  ? cellText(cells[typeIdx])     || null : null,
          amount:       amountIdx >= 0 && cells[amountIdx] ? parseDollar(cellText(cells[amountIdx])) : null,
          response:     responseIdx >= 0 && cells[responseIdx] ? cellText(cells[responseIdx]) || null : null,
          terminalBalance: balanceIdx >= 0 && cells[balanceIdx] ? parseDollar(cellText(cells[balanceIdx])) : null,
        });
      }

      return result.length > 0 ? result : null;
    });
  };

  // Try main frame first, then any child iframes (SSRS often renders into an iframe)
  let rows = await parseTxTable(page).catch(() => null);
  if (!rows) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      rows = await parseTxTable(frame as any).catch(() => null);
      if (rows) break;
    }
  }

  logger.info(
    { count: rows?.length ?? 0, hasTerminalId: rows?.some(r => r.terminalId != null) ?? false, sample: rows?.[0] ?? null },
    "Columbus Data: terminal daily report scraped"
  );

  // Group by terminalId — rows without one are stored under a shared "" key
  // (useful for debugging but won't be matched to any ATM)
  const txMap = new Map<string, ColumbusTransaction[]>();
  for (const row of rows ?? []) {
    const key = row.terminalId ?? "";
    if (!txMap.has(key)) txMap.set(key, []);
    txMap.get(key)!.push({
      transactedAt: row.transactedAt,
      cardNumber:      row.cardNumber,
      transactionType: row.transactionType,
      amount:          row.amount,
      response:        row.response,
      terminalBalance: row.terminalBalance,
    });
  }

  return txMap;
}

// ---------------------------------------------------------------------------
// Active Terminals report scraping (ReportViewer.aspx?reportname=rptActiveTerminals)
// Gives us: location name, address, city, state, machine type, surcharge
// ---------------------------------------------------------------------------

async function scrapeActiveTerminalsReport(page: Page): Promise<Map<string, ActiveTerminalInfo>> {
  logger.info({ url: ACTIVE_TERMINALS_URL }, "Columbus Data: navigating to active terminals report");

  page.goto(ACTIVE_TERMINALS_URL).catch(() => {});

  // Wait up to 20s for any table to appear
  const tableAppeared = await page.waitForSelector("table", { timeout: 20_000 })
    .then(() => true).catch(() => false);

  // If no table yet, check for a "View Report" / "Submit" button and click it
  if (!tableAppeared) {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll<HTMLElement>("input[type=submit], button, input[type=button]"))
        .find(el => /view|submit|run|generate/i.test(el.value ?? el.innerText ?? ""));
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);

    if (clicked) {
      await page.waitForSelector("table", { timeout: 20_000 }).catch(() => {});
    }
  }

  // Helper that parses the terminal table from a page or frame context
  const scrapeTable = async (ctx: Page | import("puppeteer").Frame) => {
    return ctx.evaluate(() => {
      function cellText(el: Element): string {
        return (el.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }

      // Find the most data-rich table that looks like a terminal list
      const tables = Array.from(document.querySelectorAll("table"));
      let best: HTMLTableElement | null = null;
      for (const t of tables) {
        const text = (t.textContent ?? "").toLowerCase();
        if ((text.includes("terminal") || text.includes("location")) && t.rows.length > 3) {
          if (!best || t.rows.length > best.rows.length) best = t;
        }
      }
      if (!best) return null;

      const allRows = Array.from(best.querySelectorAll("tr"));

      // Find header row (contains "terminal" and at least one of address/location/surcharge)
      const headerRow = allRows.find(r => {
        const t = (r.textContent ?? "").toLowerCase().replace(/\s+/g, "");
        return t.includes("terminal") && (t.includes("address") || t.includes("location") || t.includes("surcharge") || t.includes("city"));
      });
      if (!headerRow) return null;

      // Space-stripped comparison so "Terminal ID" matches keyword "terminalid"
      const headers = Array.from(headerRow.querySelectorAll("th, td"))
        .map(h => cellText(h).toLowerCase());
      const idx = (kw: string) => {
        const kwNorm = kw.replace(/\s+/g, "");
        return headers.findIndex(h => h.replace(/\s+/g, "").includes(kwNorm));
      };

      const termIdIdx    = idx("terminalid") !== -1 ? idx("terminalid") : idx("termid") !== -1 ? idx("termid") : 0;
      const nameIdx      = idx("locationname") !== -1 ? idx("locationname") : idx("location") !== -1 ? idx("location") : 2;
      const addressIdx   = idx("address") !== -1 ? idx("address") : 3;
      const cityIdx      = idx("city") !== -1 ? idx("city") : 5;
      const stateIdx     = idx("state") !== -1 ? idx("state") : 6;
      const modelIdx     = idx("machinetype") !== -1 ? idx("machinetype") : idx("model") !== -1 ? idx("model") : -1;
      const surchargeIdx = idx("surcharge") !== -1 ? idx("surcharge") : -1;

      const result: {
        terminalId: string;
        locationName: string | null;
        address: string | null;
        city: string | null;
        state: string | null;
        makeModel: string | null;
        surcharge: number | null;
      }[] = [];

      const headerIdx = allRows.indexOf(headerRow);
      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const cells = Array.from(allRows[i].querySelectorAll("td"));
        if (cells.length < 3) continue;
        const terminalId = cellText(cells[termIdIdx] ?? cells[0]);
        if (!terminalId || /active terminal|terminal id|^total/i.test(terminalId)) continue;

        const surchargeRaw = surchargeIdx >= 0 && cells[surchargeIdx] ? cellText(cells[surchargeIdx]) : "";
        result.push({
          terminalId,
          locationName: nameIdx < cells.length ? cellText(cells[nameIdx]) || null : null,
          address:      addressIdx < cells.length ? cellText(cells[addressIdx]) || null : null,
          city:         cityIdx < cells.length ? cellText(cells[cityIdx]) || null : null,
          state:        stateIdx < cells.length ? cellText(cells[stateIdx]) || null : null,
          makeModel:    modelIdx >= 0 && modelIdx < cells.length ? cellText(cells[modelIdx]) || null : null,
          surcharge:    surchargeRaw ? parseDollar(surchargeRaw) : null,
        });
      }
      return result.length > 0 ? result : null;
    });
  };

  // Try the main frame first, then any child iframes
  let rows = await scrapeTable(page).catch(() => null);
  if (!rows) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      rows = await scrapeTable(frame as any).catch(() => null);
      if (rows) break;
    }
  }

  logger.info({ count: rows?.length ?? 0, sample: rows?.[0] ?? null }, "Columbus Data: active terminals report scraped");

  const infoMap = new Map<string, ActiveTerminalInfo>();
  for (const row of rows ?? []) {
    if (row.terminalId) {
      infoMap.set(row.terminalId, {
        locationName: row.locationName,
        address: row.address,
        city: row.city,
        state: row.state,
        makeModel: row.makeModel,
        surcharge: row.surcharge,
      });
    }
  }
  return infoMap;
}

// ---------------------------------------------------------------------------
// Grid scraping (TerminalStatusReport.aspx)
// ---------------------------------------------------------------------------

interface GridRow {
  terminalId: string;
  terminalLabel: string;
  currentBalance: number | null;
  lastContact: string | null;
  lastError: string | null;
  isOnline: boolean;
  surcharge: null;
  makeModel: null;
  dailyCashDispensed: null;
  dailyTransactionCount: null;
}

async function setGridPageSize(page: Page, size: number): Promise<void> {
  try {
    // The Telerik pager has a page-size combo; type into its input and press Enter
    const pageSizeInput = "#rgTermStatusReport_ctl00_ctl03_ctl01_PageSizeComboBox_Input";
    const el = await page.$(pageSizeInput);
    if (el) {
      await el.triple_click?.() ?? await el.click({ clickCount: 3 });
      await el.type(String(size));
      await el.press("Enter");
      await new Promise(r => setTimeout(r, 3_000)); // wait for grid to reload
      logger.info({ size }, "Columbus Data: set grid page size");
    }
  } catch {
    // ignore — we'll just take whatever the default page size is
  }
}

async function scrapeStatusReportGrid(page: Page): Promise<GridRow[]> {
  const rows: GridRow[] = [];
  let pageNum = 1;

  while (true) {
    logger.info({ pageNum }, "Columbus Data: scraping grid page");

    const pageRows = await page.evaluate(() => {
      function cellText(cell: Element): string {
        return (cell.textContent || "").replace(/ /g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const cleaned = raw.replace(/[$,\s]/g, "");
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
      }

      // The RadGrid renders a <table> with id containing "rgTermStatusReport_ctl00"
      const table = document.querySelector("table[id*='rgTermStatusReport_ctl00']") as HTMLTableElement | null;
      if (!table) return [];

      const result: {
        terminalId: string; terminalLabel: string; currentBalance: number | null;
        lastContact: string | null; lastError: string | null; isOnline: boolean;
      }[] = [];

      // Find header row to map column indices
      const headerRow = table.querySelector("thead tr, tr.rgHeader");
      const headers: string[] = [];
      if (headerRow) {
        headerRow.querySelectorAll("th, td").forEach((th) => {
          headers.push(cellText(th).toLowerCase());
        });
      }

      // Data rows — Telerik alternates between "rgRow" and "rgAltRow" classes
      const dataRows = table.querySelectorAll("tr.rgRow, tr.rgAltRow");
      dataRows.forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length < 2) return;

        // Try to find columns by header name first, otherwise use position
        // Strip whitespace before matching so "Cash Balance" matches "cashbalance"
        const idxOf = (keyword: string) =>
          headers.findIndex((h) => h.replace(/\s+/g, "").includes(keyword.replace(/\s+/g, "")));

        const termIdIdx = idxOf("terminalid") !== -1 ? idxOf("terminalid") : 0;
        const nameIdx = idxOf("name") !== -1 ? idxOf("name") : 1;
        const balanceIdx = idxOf("cashbalance") !== -1 ? idxOf("cashbalance") : idxOf("balance") !== -1 ? idxOf("balance") : 3;
        const lastContactIdx = idxOf("lastcommunication") !== -1 ? idxOf("lastcommunication") : idxOf("communication") !== -1 ? idxOf("communication") : idxOf("lastcontact") !== -1 ? idxOf("lastcontact") : -1;
        const lastErrorIdx = idxOf("lasterror") !== -1 ? idxOf("lasterror") : idxOf("error") !== -1 ? idxOf("error") : -1;

        const terminalId = cellText(cells[termIdIdx] ?? cells[0]);
        if (!terminalId || terminalId === "Terminal ID") return; // skip header rows

        const name = cells[nameIdx] ? cellText(cells[nameIdx]) : "";
        const terminalLabel = name ? `${terminalId} - ${name}` : terminalId;
        const balanceRaw = cells[balanceIdx] ? cellText(cells[balanceIdx]) : "";
        const currentBalance = parseDollar(balanceRaw);
        const lastContact = lastContactIdx >= 0 && cells[lastContactIdx] ? cellText(cells[lastContactIdx]) : null;
        const lastError = lastErrorIdx >= 0 && cells[lastErrorIdx] ? cellText(cells[lastErrorIdx]) : null;

        // Online if last contact within 24h
        let isOnline = false;
        if (lastContact) {
          const d = new Date(lastContact);
          if (!isNaN(d.getTime())) isOnline = Date.now() - d.getTime() < 48 * 3600_000;
        }

        result.push({ terminalId, terminalLabel, currentBalance, lastContact, lastError, isOnline });
      });

      return result;
    });

    for (const r of pageRows) {
      rows.push({ ...r, surcharge: null, makeModel: null, dailyCashDispensed: null, dailyTransactionCount: null });
    }

    logger.info({ pageNum, rowsOnPage: pageRows.length, totalSoFar: rows.length }, "Columbus Data: grid page scraped");

    // Check for a "next page" button and click it
    const hasNext = await page.evaluate(() => {
      const nextBtn = document.querySelector("a[title='Next Page'], input[title='Next Page'], .rgPageNext:not(.rgPageNextDisabled)");
      if (nextBtn && !(nextBtn as HTMLElement).classList.contains("rgPageNextDisabled")) {
        (nextBtn as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (!hasNext || pageRows.length === 0) break;
    await new Promise(r => setTimeout(r, 2_500));
    pageNum++;
    if (pageNum > 20) break; // safety cap
  }

  return rows;
}
