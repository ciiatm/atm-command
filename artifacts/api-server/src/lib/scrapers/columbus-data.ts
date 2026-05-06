/**
 * Columbus Data Portal Scraper — ATM Info & Status
 *
 * Strategy:
 * 1. Login
 * 2. Navigate to TermIDStatus.aspx (Real Time Terminal Status page)
 * 3. Scrape Table2 (Merchant Info: Terminal ID, Location Name, Address, City,
 *    State, Postal Code, Property Type) and Table3 (Terminal Status: Make/Model,
 *    Balance, Last Contact) for the current terminal
 * 4. Click "Next Terminal" (#btnNext) to advance and repeat
 * 5. Stop when a terminal ID is seen a second time (loop detection)
 * 6. If TermIDStatus approach returns 0 results, fall back to the proven
 *    grid + Active Terminals report approach
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL        = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const TERM_STATUS_URL  = "https://www.columbusdata.net/cdswebtool/QuickView/TermIDStatus.aspx";
const REPORT_URL       = "https://www.columbusdata.net/cdswebtool/QuickView/TerminalStatusReport.aspx";
const ACTIVE_TERMS_URL = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx?reportname=rptActiveTerminals";

export interface ColumbusTerminalStatus {
  terminalId: string;
  terminalLabel: string;
  // From Table2 (Merchant Info)
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  propertyType: string | null;
  // From Table3 (Terminal Status) / Active Terminals report
  makeModel: string | null;
  surcharge: number | null;
  // From Table3 (Terminal Status) / Status Report grid
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
    logger.info("Columbus Data: login successful");

    // ------------------------------------------------------------------
    // Step 2: Try TermIDStatus.aspx approach (primary)
    // ------------------------------------------------------------------
    const termIdResults = await scrapeViaTermIDStatus(page);
    if (termIdResults.length > 0) {
      logger.info({ count: termIdResults.length }, "Columbus Data: TermIDStatus scrape complete");
      return termIdResults;
    }

    // ------------------------------------------------------------------
    // Fallback: Grid + Active Terminals report (proven, 76 ATMs)
    // ------------------------------------------------------------------
    logger.warn("Columbus Data: TermIDStatus returned 0 results — falling back to grid approach");
    return await scrapeViaGridAndReport(page);

  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// PRIMARY: TermIDStatus.aspx — cycles through all terminals using Next button
// ---------------------------------------------------------------------------

async function scrapeViaTermIDStatus(page: Page): Promise<ColumbusTerminalStatus[]> {
  logger.info({ url: TERM_STATUS_URL }, "Columbus Data: navigating to TermIDStatus.aspx");
  await page.goto(TERM_STATUS_URL, { waitUntil: "domcontentloaded" });

  // Wait up to 10s for Table2 to show data (session may pre-load a terminal)
  let table2Loaded = await page.waitForSelector("#Table2 td.tmdata", { timeout: 10_000 })
    .then(() => true).catch(() => false);

  if (!table2Loaded) {
    // No terminal pre-loaded — click Get Status to load the first/default terminal
    logger.info("Columbus Data: Table2 empty on load — clicking Get Status");
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>("#btnGetStatus");
      if (btn) btn.click();
    });
    table2Loaded = await page.waitForSelector("#Table2 td.tmdata", { timeout: 20_000 })
      .then(() => true).catch(() => false);
  }

  if (!table2Loaded) {
    logger.warn("Columbus Data: TermIDStatus Table2 not found — page may require terminal selection");
    return [];
  }

  // Give UpdatePanel a moment to settle
  await new Promise(r => setTimeout(r, 1_000));

  const results: ColumbusTerminalStatus[] = [];
  const seenIds = new Set<string>();
  let iteration = 0;
  const MAX_TERMINALS = 300; // safety cap

  while (iteration < MAX_TERMINALS) {
    // Read Table2 and Table3 for the current terminal
    const termData = await page.evaluate(() => {
      function cellText(el: Element | null): string {
        return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }
      function parseDate(raw: string): string | null {
        const t = raw.trim();
        return t || null;
      }

      // ---- Table2: Merchant Information ----
      // Columns (0-based): Terminal ID, Location Name, Address, City,
      //                     State/Province, Postal Code, Telephone, Contact, Property Type
      // Avoid :has() — iterate rows for compatibility with older Chrome builds
      let t2DataCells: Element[] = [];
      let t2Headers: string[] = [];
      const table2 = document.querySelector<HTMLTableElement>("#Table2");
      if (table2) {
        for (const row of Array.from(table2.querySelectorAll("tr"))) {
          const dataCells = Array.from(row.querySelectorAll("td.tmdata"));
          const headerCells = Array.from(row.querySelectorAll("td.tmdatalabel"));
          if (dataCells.length >= 3 && t2DataCells.length === 0) {
            t2DataCells = Array.from(row.querySelectorAll("td")); // all cells in data row
          }
          if (headerCells.length >= 3 && t2Headers.length === 0) {
            t2Headers = headerCells.map(h => cellText(h).toLowerCase());
          }
        }
      }

      if (t2DataCells.length === 0) return null;

      function t2ColIdx(keyword: string): number {
        const k = keyword.toLowerCase();
        const idx = t2Headers.findIndex(h => h.includes(k));
        return idx >= 0 ? idx : -1;
      }

      // Column indices with fallbacks
      const colTerminalId   = t2ColIdx("terminal id") >= 0 ? t2ColIdx("terminal id") : 0;
      const colLocationName = t2ColIdx("location")    >= 0 ? t2ColIdx("location")    : 1;
      const colAddress      = t2ColIdx("address")     >= 0 ? t2ColIdx("address")     : 2;
      const colCity         = t2ColIdx("city")        >= 0 ? t2ColIdx("city")        : 3;
      const colState        = t2ColIdx("state")       >= 0 ? t2ColIdx("state")       : 4;
      const colPostal       = t2ColIdx("postal")      >= 0 ? t2ColIdx("postal")      : 5;
      const colPropType     = t2ColIdx("property")    >= 0 ? t2ColIdx("property")    : 8;

      const terminalId   = cellText(t2DataCells[colTerminalId] ?? t2DataCells[0]);
      const locationName = t2DataCells[colLocationName] ? cellText(t2DataCells[colLocationName]) || null : null;
      const address      = t2DataCells[colAddress]      ? cellText(t2DataCells[colAddress])      || null : null;
      const city         = t2DataCells[colCity]         ? cellText(t2DataCells[colCity])         || null : null;
      const state        = t2DataCells[colState]        ? cellText(t2DataCells[colState])        || null : null;
      const postalCode   = t2DataCells[colPostal]       ? cellText(t2DataCells[colPostal])       || null : null;
      const propertyType = t2DataCells[colPropType]     ? cellText(t2DataCells[colPropType])     || null : null;

      // ---- Surcharge from litCurrentSurchargePanel ----
      const surchargeText = cellText(document.querySelector("#litCurrentSurchargePanel"));
      const surchargeMatch = surchargeText.match(/\$?([\d,]+\.?\d*)/);
      const surcharge = surchargeMatch ? parseDollar(surchargeMatch[0]) : null;

      // ---- Table3: Terminal Status ----
      // Columns: Make/Model, Comm Type, Current Balance, Last Error,
      //          Last Contact, Last Message, Last App W/D, Install Date
      // Avoid :has() — iterate rows for compatibility
      let t3DataCells: Element[] = [];
      let t3Headers: string[] = [];
      const table3 = document.querySelector<HTMLTableElement>("#Table3");
      if (table3) {
        for (const row of Array.from(table3.querySelectorAll("tr"))) {
          const dataCells = Array.from(row.querySelectorAll("td.tmdata"));
          const headerCells = Array.from(row.querySelectorAll("td.tmdatalabel"));
          if (dataCells.length >= 2 && t3DataCells.length === 0) {
            t3DataCells = Array.from(row.querySelectorAll("td")); // all cells in data row
          }
          if (headerCells.length >= 2 && t3Headers.length === 0) {
            t3Headers = headerCells.map(h => cellText(h).toLowerCase());
          }
        }
      }

      function t3ColIdx(keyword: string): number {
        const k = keyword.toLowerCase();
        const idx = t3Headers.findIndex(h => h.includes(k));
        return idx >= 0 ? idx : -1;
      }

      const colMakeModel   = t3ColIdx("make")    >= 0 ? t3ColIdx("make")    : 0;
      const colBalance     = t3ColIdx("balance")  >= 0 ? t3ColIdx("balance") : 2;
      const colLastContact = t3ColIdx("contact")  >= 0 ? t3ColIdx("contact") : 4;

      // Prefer the dedicated #curbalid element for balance
      const balanceEl = document.querySelector("#curbalid");
      const balanceRaw = balanceEl ? cellText(balanceEl) : (t3DataCells[colBalance] ? cellText(t3DataCells[colBalance]) : "");
      const currentBalance = parseDollar(balanceRaw);

      const makeModel  = t3DataCells[colMakeModel]   ? cellText(t3DataCells[colMakeModel])   || null : null;
      const lastContactRaw = t3DataCells[colLastContact] ? cellText(t3DataCells[colLastContact]) : "";
      const lastContact = parseDate(lastContactRaw);

      // isOnline: last contact within 48h
      let isOnline = false;
      if (lastContact) {
        const d = new Date(lastContact);
        if (!isNaN(d.getTime())) isOnline = Date.now() - d.getTime() < 48 * 3_600_000;
      }

      return {
        terminalId,
        locationName,
        address,
        city,
        state,
        postalCode,
        propertyType,
        makeModel,
        surcharge,
        currentBalance,
        lastContact,
        isOnline,
      };
    });

    if (!termData || !termData.terminalId) {
      logger.warn({ iteration }, "Columbus Data: could not read terminal data from Table2, stopping");
      break;
    }

    const { terminalId } = termData;

    // Loop detection
    if (seenIds.has(terminalId)) {
      logger.info({ terminalId, iteration, total: results.length }, "Columbus Data: loop detected (terminal seen before), stopping");
      break;
    }
    seenIds.add(terminalId);

    results.push({
      terminalId,
      terminalLabel: termData.locationName ? `${terminalId} - ${termData.locationName}` : terminalId,
      locationName: termData.locationName,
      address: termData.address,
      city: termData.city,
      state: termData.state,
      postalCode: termData.postalCode,
      propertyType: termData.propertyType,
      makeModel: termData.makeModel,
      surcharge: termData.surcharge,
      currentBalance: termData.currentBalance,
      lastContact: termData.lastContact,
      isOnline: termData.isOnline,
    });

    logger.info(
      { terminalId, balance: termData.currentBalance, postalCode: termData.postalCode, propertyType: termData.propertyType, iteration },
      "Columbus Data: scraped terminal"
    );

    // Click Next Terminal
    const nextClicked = await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>("#btnNext");
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!nextClicked) {
      logger.info("Columbus Data: #btnNext not found, stopping");
      break;
    }

    // Wait for Table2 to update to a new terminal ID
    try {
      await page.waitForFunction(
        (prevId: string) => {
          const cells = document.querySelectorAll("#Table2 td.tmdata");
          if (!cells[0]) return false;
          const cur = (cells[0].textContent ?? "").replace(/\s+/g, " ").trim();
          return cur !== "" && cur !== prevId;
        },
        { timeout: 15_000 },
        terminalId,
      );
    } catch {
      logger.warn({ terminalId, iteration }, "Columbus Data: timed out waiting for next terminal, stopping");
      break;
    }

    // Small buffer for UpdatePanel to fully settle
    await new Promise(r => setTimeout(r, 500));
    iteration++;
  }

  logger.info({ scraped: results.length, iterations: iteration }, "Columbus Data: TermIDStatus cycle complete");
  return results;
}

// ---------------------------------------------------------------------------
// FALLBACK: Proven grid + Active Terminals report approach
// ---------------------------------------------------------------------------

async function scrapeViaGridAndReport(page: Page): Promise<ColumbusTerminalStatus[]> {
  // Active Terminals report — location, address, make/model, surcharge
  const activeTerminalsMap = await scrapeActiveTerminalsReport(page);
  logger.info({ count: activeTerminalsMap.size }, "Columbus Data (fallback): active terminals report done");

  // Status Report grid — balance, last contact, online status
  logger.info("Columbus Data (fallback): navigating to status report grid");
  page.goto(REPORT_URL).catch(() => {});

  const gridFound = await page
    .waitForSelector("table[id*='rgTermStatusReport']", { timeout: 45_000 })
    .then(() => true).catch(() => false);

  if (!gridFound) {
    const html = await page.evaluate(() => document.body?.innerHTML?.slice(0, 2000) ?? "");
    logger.warn({ html }, "Columbus Data (fallback): grid not found");
    throw new Error("Columbus Data: status report grid not found after 45s");
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
  logger.info({ count: gridRows.length }, "Columbus Data (fallback): scraped grid rows");

  if (gridRows.length === 0) {
    throw new Error("Columbus Data: no terminal rows found in status report grid");
  }

  // Merge and return
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
      postalCode: null,
      propertyType: null,
      currentBalance: row.currentBalance,
      lastContact: row.lastContact,
      isOnline: row.isOnline,
    };
  });

  // Deduplicate
  const seen = new Set<string>();
  const deduped = results.filter(r => {
    if (seen.has(r.terminalId)) return false;
    seen.add(r.terminalId);
    return true;
  });

  logger.info({ scraped: results.length, deduped: deduped.length }, "Columbus Data (fallback): sync complete");
  return deduped;
}

// ---------------------------------------------------------------------------
// Active Terminals report helper (fallback path only)
// ---------------------------------------------------------------------------

async function scrapeActiveTerminalsReport(page: Page): Promise<Map<string, ActiveTerminalInfo>> {
  logger.info({ url: ACTIVE_TERMS_URL }, "Columbus Data: navigating to active terminals report");
  page.goto(ACTIVE_TERMS_URL).catch(() => {});

  const tableAppeared = await page.waitForSelector("table", { timeout: 20_000 })
    .then(() => true).catch(() => false);

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
// Status Report grid helper (fallback path only)
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
