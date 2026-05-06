/**
 * Columbus Data Portal Scraper
 *
 * Strategy:
 * 1. Login to the portal
 * 2. Scrape the "Terminal Status Report" grid — shows ALL terminals with
 *    balance, last contact, last error on a single page (most reliable)
 * 3. For each terminal found in the grid, also visit TermIDStatus.aspx
 *    to pull today's individual transactions from Table5
 *
 * Requires: puppeteer
 * On EC2/Linux: google-chrome-stable (non-snap) must be installed.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const REPORT_URL = "https://www.columbusdata.net/cdswebtool/QuickView/TerminalStatusReport.aspx";
const MONITOR_URL = "https://www.columbusdata.net/cdswebtool/TerminalMonitoring/TermIDStatus.aspx";
const ACTIVE_TERMINALS_URL = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptActiveTerminals";

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
    // Step 2: Scrape the Active Terminals report for location/address info
    // ------------------------------------------------------------------
    const activeTerminalsMap = await scrapeActiveTerminalsReport(page);
    logger.info({ count: activeTerminalsMap.size }, "Columbus Data: active terminals report done");

    // ------------------------------------------------------------------
    // Step 3: Scrape the Terminal Status Report grid (balance / online status)
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
    // Step 4: For each terminal, get today's transactions from the monitor
    // ------------------------------------------------------------------
    logger.info({ url: MONITOR_URL }, "Columbus Data: navigating to terminal monitor for transactions");
    page.goto(MONITOR_URL).catch(() => {});

    const monitorFound = await page
      .waitForSelector("[id*='radTerminalSelector']", { timeout: 30_000 })
      .then(() => true).catch(() => false);

    logger.info({ monitorFound }, "Columbus Data: terminal monitor loaded");

    const results: ColumbusTerminalStatus[] = [];

    for (const row of gridRows) {
      // Merge in location/address info from the active terminals report
      const info = activeTerminalsMap.get(row.terminalId);

      // Look up transactions for this terminal if the monitor is available
      let transactions: ColumbusTransaction[] = [];
      if (monitorFound) {
        try {
          transactions = await getTerminalTransactions(page, row.terminalId, row.terminalLabel);
        } catch (err) {
          logger.warn({ termId: row.terminalId, err: (err as Error).message }, "Columbus Data: transaction scrape failed, skipping");
        }
      }

      results.push({
        ...row,
        locationName: info?.locationName ?? null,
        address: info?.address ?? null,
        city: info?.city ?? null,
        state: info?.state ?? null,
        makeModel: info?.makeModel ?? row.makeModel,
        surcharge: info?.surcharge ?? null,
        transactions,
      });
    }

    logger.info({ count: results.length }, "Columbus Data: sync complete");
    return results;
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Active Terminals report scraping (ReportViewer.aspx?reportname=rptActiveTerminals)
// Gives us: location name, address, city, state, machine type, surcharge
// ---------------------------------------------------------------------------

async function scrapeActiveTerminalsReport(page: Page): Promise<Map<string, ActiveTerminalInfo>> {
  logger.info({ url: ACTIVE_TERMINALS_URL }, "Columbus Data: navigating to active terminals report");

  // Fire-and-forget navigate; the page may keep loading indefinitely
  page.goto(ACTIVE_TERMINALS_URL).catch(() => {});

  // Give the page up to 30 s to render some kind of table
  await new Promise(r => setTimeout(r, 5_000));

  // If there's a "View Report" / "Submit" button (common in SSRS wrappers) click it
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("input[type=submit], button"))
      .find(el => /view|submit|run|generate/i.test((el as HTMLElement).innerText ?? "")) as HTMLElement | null;
    if (btn) btn.click();
  }).catch(() => {});

  await new Promise(r => setTimeout(r, 5_000));

  // The content might be rendered directly in the page or inside an iframe.
  // Try the main page first, then each iframe.
  const scrapeTable = async (ctx: Page | import("puppeteer").Frame) => {
    return ctx.evaluate(() => {
      function cellText(el: Element): string {
        return (el.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }

      // Find all tables; pick the one that looks like a terminal list
      const tables = Array.from(document.querySelectorAll("table"));
      let best: HTMLTableElement | null = null;
      for (const t of tables) {
        const text = t.textContent?.toLowerCase() ?? "";
        if ((text.includes("terminal") || text.includes("location")) && t.rows.length > 3) {
          best = t;
          break;
        }
      }
      if (!best) return null;

      // Detect header row
      const allRows = Array.from(best.querySelectorAll("tr"));
      const headerRow = allRows.find(r => {
        const t = (r.textContent ?? "").toLowerCase();
        return t.includes("terminal") && (t.includes("address") || t.includes("location") || t.includes("surcharge"));
      });
      if (!headerRow) return null;

      const headers = Array.from(headerRow.querySelectorAll("th, td")).map(h => cellText(h).toLowerCase());
      const idx = (kw: string) => headers.findIndex(h => h.includes(kw));

      // Column indices — use Excel export column order as fallback positions
      const termIdIdx   = idx("terminal id") !== -1 ? idx("terminal id") : idx("term id") !== -1 ? idx("term id") : 0;
      const nameIdx     = idx("location name") !== -1 ? idx("location name") : idx("location") !== -1 ? idx("location") : 2;
      const addressIdx  = idx("address") !== -1 ? idx("address") : 3;
      const cityIdx     = idx("city") !== -1 ? idx("city") : 5;
      const stateIdx    = idx("state") !== -1 ? idx("state") : 6;
      const modelIdx    = idx("machine type") !== -1 ? idx("machine type") : idx("model") !== -1 ? idx("model") : 12;
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
        if (!terminalId || /active terminal|terminal id/i.test(terminalId)) continue;

        const surchargeRaw = surchargeIdx >= 0 && cells[surchargeIdx] ? cellText(cells[surchargeIdx]) : "";
        result.push({
          terminalId,
          locationName: nameIdx < cells.length ? cellText(cells[nameIdx]) || null : null,
          address: addressIdx < cells.length ? cellText(cells[addressIdx]) || null : null,
          city: cityIdx < cells.length ? cellText(cells[cityIdx]) || null : null,
          state: stateIdx < cells.length ? cellText(cells[stateIdx]) || null : null,
          makeModel: modelIdx < cells.length ? cellText(cells[modelIdx]) || null : null,
          surcharge: surchargeRaw ? parseDollar(surchargeRaw) : null,
        });
      }
      return result;
    });
  };

  // Try main page
  let rows = await scrapeTable(page).catch(() => null);

  // If nothing found, try each iframe
  if (!rows || rows.length === 0) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      rows = await scrapeTable(frame as any).catch(() => null);
      if (rows && rows.length > 0) break;
    }
  }

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

  logger.info({ count: infoMap.size }, "Columbus Data: active terminals report scraped");
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
        const idxOf = (keyword: string) => headers.findIndex((h) => h.includes(keyword));

        const termIdIdx = idxOf("terminalid") !== -1 ? idxOf("terminalid") : 0;
        const nameIdx = idxOf("name") !== -1 ? idxOf("name") : 1;
        const balanceIdx = idxOf("cashbalance") !== -1 ? idxOf("cashbalance") : 3;
        const lastContactIdx = idxOf("lastcommunication") !== -1 ? idxOf("lastcommunication") : -1;
        const lastErrorIdx = idxOf("lasterror") !== -1 ? idxOf("lasterror") : -1;

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

// ---------------------------------------------------------------------------
// Per-terminal transaction scraping (TermIDStatus.aspx)
// ---------------------------------------------------------------------------

async function getTerminalTransactions(
  page: Page,
  termId: string,
  termLabel: string,
): Promise<ColumbusTransaction[]> {
  // Select this terminal in the dropdown
  await page.evaluate(
    (id, label) => {
      const inputs = Array.from(document.querySelectorAll("input[type=hidden]")) as HTMLInputElement[];
      for (const input of inputs) {
        if (input.id?.includes("radTerminalSelector_ClientState")) {
          input.value = JSON.stringify({ value: id, text: label, logEntries: [], enabled: true, checkedIndices: [], checkedItemsTextOverFlow: "" });
          break;
        }
      }
      const visibleInput = document.querySelector("input[id*='radTerminalSelector_Input']") as HTMLInputElement | null;
      if (visibleInput) visibleInput.value = label;

      // Click matching <li> if dropdown is open
      const li = Array.from(document.querySelectorAll("#cbsTerminals_radTerminalSelector_DropDown li"))
        .find((el) => el.textContent?.trim().startsWith(id));
      if (li) (li as HTMLElement).click();
    },
    termId,
    termLabel,
  );

  await new Promise(r => setTimeout(r, 500));

  // Click Get Status
  const btnGetStatus = await page.$("#btnGetStatus");
  if (btnGetStatus) {
    await btnGetStatus.click();
    await new Promise(r => setTimeout(r, 3_000));
  }

  // Scrape Table5 transactions
  return await page.evaluate(() => {
    function cellText(cell: Element): string {
      return (cell.textContent || "").replace(/ /g, " ").trim();
    }
    function parseDollar(raw: string): number | null {
      const cleaned = raw.replace(/[$,\s]/g, "");
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    }

    const txs: {
      transactedAt: string; cardNumber: string | null; transactionType: string | null;
      amount: number | null; response: string | null; terminalBalance: number | null;
    }[] = [];

    const table5 = document.querySelector("#Table5");
    if (!table5) return txs;

    table5.querySelectorAll("tr").forEach((tr) => {
      const cells = tr.querySelectorAll("td.tmDataGrid");
      if (cells.length < 5) return;
      const transactedAt = cellText(cells[0]);
      if (!transactedAt) return;
      txs.push({
        transactedAt,
        cardNumber: cellText(cells[1]) || null,
        transactionType: cellText(cells[2]) || null,
        amount: parseDollar(cellText(cells[3])),
        response: cellText(cells[4]) || null,
        terminalBalance: cells[5] ? parseDollar(cellText(cells[5])) : null,
      });
    });

    return txs;
  });
}

// ---------------------------------------------------------------------------
// Helper: find visible input by trying selectors in order
// ---------------------------------------------------------------------------

async function findInputSelector(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await page.evaluate(
          (e) => !!(e as HTMLElement).offsetParent || (e as HTMLElement).style.display !== "none",
          el,
        );
        if (visible) return sel;
      }
    } catch { /* try next */ }
  }
  return null;
}

// keep export for type compatibility
export type { findInputSelector };
