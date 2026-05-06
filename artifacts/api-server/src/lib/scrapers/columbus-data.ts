/**
 * Columbus Data Portal Scraper — ATM Info & Status (Scraper 1)
 *
 * Strategy:
 * 1. Login
 * 2. Scrape the Active Terminals report (rptActiveTerminals) — location name,
 *    address, city, state, make/model, surcharge
 * 3. Scrape the Terminal Status Report grid (TerminalStatusReport.aspx) —
 *    terminal IDs, current balance, last contact, online status
 * 4. Merge and return
 *
 * postalCode and propertyType are included in the interface (schema columns exist)
 * but are not yet populated — TermIDStatus.aspx per-terminal scraping will be
 * added once we can verify the live page selectors via server logs.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL          = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const REPORT_URL         = "https://www.columbusdata.net/cdswebtool/QuickView/TerminalStatusReport.aspx";
const ACTIVE_TERMS_URL   = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptActiveTerminals";

export interface ColumbusTerminalStatus {
  terminalId: string;
  terminalLabel: string;
  // From Active Terminals report
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  makeModel: string | null;
  surcharge: number | null;
  // Reserved — populated by future TermIDStatus.aspx enrichment
  postalCode: string | null;
  propertyType: string | null;
  // From the Status Report grid
  currentBalance: number | null;
  lastContact: string | null;
  isOnline: boolean;
}

interface ActiveTerminalInfo {
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  makeModel: string | null;
  surcharge: number | null;
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

    // ------------------------------------------------------------------
    // Step 2: Active Terminals report — location, address, make/model
    // ------------------------------------------------------------------
    const activeTerminalsMap = await scrapeActiveTerminalsReport(page);
    logger.info({ count: activeTerminalsMap.size }, "Columbus Data: active terminals report done");

    // ------------------------------------------------------------------
    // Step 3: Status Report grid — balance, last contact, online status
    // ------------------------------------------------------------------
    logger.info("Columbus Data: navigating to status report grid");
    page.goto(REPORT_URL).catch(() => {});

    const gridFound = await page
      .waitForSelector("table[id*='rgTermStatusReport']", { timeout: 45_000 })
      .then(() => true).catch(() => false);

    logger.info({ gridFound }, "Columbus Data: status report grid loaded");
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
    logger.info({ count: gridRows.length }, "Columbus Data: scraped grid rows");

    if (gridRows.length === 0) {
      throw new Error("Columbus Data: no terminal rows found in status report grid");
    }

    // ------------------------------------------------------------------
    // Step 4: Merge and return
    // ------------------------------------------------------------------
    const results: ColumbusTerminalStatus[] = gridRows.map(row => {
      const info = activeTerminalsMap.get(row.terminalId);
      return {
        terminalId: row.terminalId,
        terminalLabel: row.terminalLabel,
        locationName: info?.locationName ?? null,
        address: info?.address ?? null,
        city: info?.city ?? null,
        state: info?.state ?? null,
        makeModel: info?.makeModel ?? null,
        surcharge: info?.surcharge ?? null,
        postalCode: null,    // future: TermIDStatus.aspx Table2
        propertyType: null,  // future: TermIDStatus.aspx Table2
        currentBalance: row.currentBalance,
        lastContact: row.lastContact,
        isOnline: row.isOnline,
      };
    });

    // Deduplicate by terminalId
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
// Active Terminals report — location name, address, city, state, make/model, surcharge
// ---------------------------------------------------------------------------

async function scrapeActiveTerminalsReport(page: Page): Promise<Map<string, ActiveTerminalInfo>> {
  logger.info({ url: ACTIVE_TERMS_URL }, "Columbus Data: navigating to active terminals report");
  page.goto(ACTIVE_TERMS_URL).catch(() => {});

  // Wait up to 20s for any table
  const tableAppeared = await page.waitForSelector("table", { timeout: 20_000 })
    .then(() => true).catch(() => false);

  // Click a View Report / Submit button if present
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll<HTMLElement>(
      "input[type=submit], button, input[type=button]"
    )).find(el => /view|submit|run|generate/i.test(
      (el as HTMLInputElement).value ?? (el as HTMLButtonElement).innerText ?? ""
    ));
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);

  if (clicked || !tableAppeared) {
    await page.waitForSelector("table", { timeout: 20_000 }).catch(() => {});
  }

  const scrapeTable = async (ctx: Page | import("puppeteer").Frame) => {
    return ctx.evaluate(() => {
      function cellText(el: Element): string {
        return (el.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }

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
      const headerRow = allRows.find(r => {
        const t = (r.textContent ?? "").toLowerCase().replace(/\s+/g, "");
        return t.includes("terminal") && (t.includes("address") || t.includes("location") || t.includes("surcharge") || t.includes("city"));
      });
      if (!headerRow) return null;

      const headers = Array.from(headerRow.querySelectorAll("th, td"))
        .map(h => cellText(h).toLowerCase());
      const idx = (kw: string) => {
        const n = kw.replace(/\s+/g, "");
        return headers.findIndex(h => h.replace(/\s+/g, "").includes(n));
      };

      const termIdIdx    = idx("terminalid") !== -1 ? idx("terminalid") : idx("termid") !== -1 ? idx("termid") : 0;
      const nameIdx      = idx("locationname") !== -1 ? idx("locationname") : idx("location") !== -1 ? idx("location") : 2;
      const addressIdx   = idx("address") !== -1 ? idx("address") : 3;
      const cityIdx      = idx("city") !== -1 ? idx("city") : 5;
      const stateIdx     = idx("state") !== -1 ? idx("state") : 6;
      const modelIdx     = idx("machinetype") !== -1 ? idx("machinetype") : idx("model") !== -1 ? idx("model") : -1;
      const surchargeIdx = idx("surcharge") !== -1 ? idx("surcharge") : -1;

      const result: {
        terminalId: string; locationName: string | null; address: string | null;
        city: string | null; state: string | null; makeModel: string | null; surcharge: number | null;
      }[] = [];

      const headerIdx = allRows.indexOf(headerRow);
      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const cells = Array.from(allRows[i].querySelectorAll("td"));
        if (cells.length < 3) continue;
        const terminalId = cellText(cells[termIdIdx] ?? cells[0]);
        if (!terminalId || /active terminal|terminal id|^total/i.test(terminalId)) continue;

        result.push({
          terminalId,
          locationName: nameIdx < cells.length ? cellText(cells[nameIdx]) || null : null,
          address:      addressIdx < cells.length ? cellText(cells[addressIdx]) || null : null,
          city:         cityIdx < cells.length ? cellText(cells[cityIdx]) || null : null,
          state:        stateIdx < cells.length ? cellText(cells[stateIdx]) || null : null,
          makeModel:    modelIdx >= 0 && modelIdx < cells.length ? cellText(cells[modelIdx]) || null : null,
          surcharge:    surchargeIdx >= 0 && cells[surchargeIdx]
            ? parseDollar(cellText(cells[surchargeIdx]))
            : null,
        });
      }
      return result.length > 0 ? result : null;
    });
  };

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
// Status Report grid — terminal IDs, balance, last contact, online status
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

        const name         = cells[nameIdx] ? cellText(cells[nameIdx]) : "";
        const terminalLabel = name ? `${terminalId} - ${name}` : terminalId;
        const balanceRaw   = cells[balanceIdx] ? cellText(cells[balanceIdx]) : "";
        const currentBalance = parseDollar(balanceRaw);
        const lastContact  = lastContactIdx >= 0 && cells[lastContactIdx]
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
