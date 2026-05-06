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
  currentBalance: number | null;
  surcharge: number | null;
  lastContact: string | null;
  makeModel: string | null;
  dailyCashDispensed: number | null;
  dailyTransactionCount: number | null;
  isOnline: boolean;
  transactions: ColumbusTransaction[];
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
    // Step 2: Scrape the Terminal Status Report grid (all terminals at once)
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
    // Step 3: For each terminal, get today's transactions from the monitor
    // ------------------------------------------------------------------
    // Navigate to the terminal monitor page for transaction detail
    logger.info({ url: MONITOR_URL }, "Columbus Data: navigating to terminal monitor for transactions");
    page.goto(MONITOR_URL).catch(() => {});

    const monitorFound = await page
      .waitForSelector("[id*='radTerminalSelector']", { timeout: 30_000 })
      .then(() => true).catch(() => false);

    logger.info({ monitorFound }, "Columbus Data: terminal monitor loaded");

    const results: ColumbusTerminalStatus[] = [];

    for (const row of gridRows) {
      // Look up transactions for this terminal if the monitor is available
      let transactions: ColumbusTransaction[] = [];
      if (monitorFound) {
        try {
          transactions = await getTerminalTransactions(page, row.terminalId, row.terminalLabel);
        } catch (err) {
          logger.warn({ termId: row.terminalId, err: (err as Error).message }, "Columbus Data: transaction scrape failed, skipping");
        }
      }
      results.push({ ...row, transactions });
    }

    logger.info({ count: results.length }, "Columbus Data: sync complete");
    return results;
  } finally {
    await browser?.close().catch(() => {});
  }
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
      await page.waitForTimeout(3_000); // wait for grid to reload
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
          if (!isNaN(d.getTime())) isOnline = Date.now() - d.getTime() < 24 * 3600_000;
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
    await page.waitForTimeout(2_500);
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

  await page.waitForTimeout(500);

  // Click Get Status
  const btnGetStatus = await page.$("#btnGetStatus");
  if (btnGetStatus) {
    await btnGetStatus.click();
    await page.waitForTimeout(3_000);
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
