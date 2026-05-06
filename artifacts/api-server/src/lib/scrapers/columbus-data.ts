/**
 * Columbus Data Portal Scraper — ATM Info & Status (Scraper 1)
 *
 * Strategy:
 * 1. Login
 * 2. Scrape TerminalStatusReport.aspx grid to get the terminal ID list (fast)
 * 3. Open CONCURRENCY parallel browser pages
 * 4. Each page cycles through its assigned terminals:
 *    - Tries URL param first: TermIDStatus.aspx?TermID={id}
 *    - Falls back to Telerik dropdown + #btnGetStatus click
 *    - Scrapes Table2 (Merchant Info) and Table3 (Terminal Status)
 *
 * Table2 columns (row 2, fixed positions):
 *   0=Terminal ID, 1=Location Name, 2=Address, 3=City, 4=State,
 *   5=Postal Code, 6=Telephone, 7=Contact, 8=Property Type
 *
 * Table3 columns (row 2, fixed positions):
 *   0=Make/Model, 1=Comm Type, 2=Current Balance (#curbalid),
 *   3=Last Error, 4=Last Contact, 5=Last Message, 6=Last App W/D, 7=Install Date
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL    = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const TERM_LIST_URL = "https://www.columbusdata.net/cdswebtool/QuickView/TerminalStatusReport.aspx";
const TERM_STATUS_URL = "https://www.columbusdata.net/cdswebtool/QuickView/TermIDStatus.aspx";
const CONCURRENCY  = 5;

export interface ColumbusTerminalStatus {
  terminalId: string;
  terminalLabel: string;
  // Table2: Merchant Information
  locationName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  propertyType: string | null;
  // Table3: Terminal Status
  makeModel: string | null;
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

    // ----------------------------------------------------------------
    // Step 1: Login
    // ----------------------------------------------------------------
    const loginPage = await browser.newPage();
    loginPage.setDefaultNavigationTimeout(60_000);
    loginPage.setDefaultTimeout(30_000);

    logger.info("Columbus Data: logging in");
    await loginPage.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await loginPage.waitForSelector("#UsernameTextbox", { visible: true });
    await loginPage.type("#UsernameTextbox", username, { delay: 30 });
    await loginPage.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      loginPage.waitForNavigation({ waitUntil: "domcontentloaded" }),
      loginPage.click("#LoginButton"),
    ]);
    if (/login/i.test(loginPage.url())) {
      throw new Error("Columbus Data login failed — still on login page, check credentials");
    }

    // ----------------------------------------------------------------
    // Step 2: Get terminal ID list from the status grid
    // ----------------------------------------------------------------
    const terminalIds = await scrapeTerminalIdList(loginPage);
    logger.info({ count: terminalIds.length }, "Columbus Data: got terminal list");
    if (terminalIds.length === 0) throw new Error("Columbus Data: no terminals found in grid");

    // ----------------------------------------------------------------
    // Step 3: Open worker pages and scrape terminals in parallel
    // ----------------------------------------------------------------
    const workerPages: Page[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const p = await browser.newPage();
      p.setDefaultNavigationTimeout(60_000);
      p.setDefaultTimeout(30_000);
      workerPages.push(p);
    }

    // Round-robin distribute terminal IDs across workers
    const chunks: string[][] = Array.from({ length: CONCURRENCY }, () => []);
    terminalIds.forEach((id, i) => chunks[i % CONCURRENCY].push(id));

    const chunkResults = await Promise.all(
      workerPages.map((wp, i) => processChunk(wp, chunks[i]))
    );

    const all = chunkResults.flat().filter((r): r is ColumbusTerminalStatus => r !== null);

    // Deduplicate by terminalId
    const seen = new Set<string>();
    const deduped = all.filter(r => {
      if (seen.has(r.terminalId)) return false;
      seen.add(r.terminalId);
      return true;
    });

    logger.info({ scraped: all.length, deduped: deduped.length }, "Columbus Data: sync complete");
    return deduped;
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Step 2: Get terminal IDs from the status report grid
// ---------------------------------------------------------------------------

async function scrapeTerminalIdList(page: Page): Promise<string[]> {
  logger.info("Columbus Data: loading terminal list from grid");
  page.goto(TERM_LIST_URL).catch(() => {});

  const found = await page
    .waitForSelector("table[id*='rgTermStatusReport_ctl00']", { timeout: 45_000 })
    .then(() => true).catch(() => false);
  if (!found) throw new Error("Columbus Data: terminal list grid did not load");

  // Try to expand page size so all terminals appear on one page
  try {
    const sizeInput = await page.$("#rgTermStatusReport_ctl00_ctl03_ctl01_PageSizeComboBox_Input");
    if (sizeInput) {
      await sizeInput.click({ clickCount: 3 });
      await sizeInput.type("500");
      await sizeInput.press("Enter");
      await new Promise(r => setTimeout(r, 3_000));
    }
  } catch { /* ignore */ }

  return page.evaluate(() => {
    const table = document.querySelector("table[id*='rgTermStatusReport_ctl00']");
    if (!table) return [];
    const ids: string[] = [];
    table.querySelectorAll("tr.rgRow, tr.rgAltRow").forEach(tr => {
      const cells = tr.querySelectorAll("td");
      if (cells.length > 0) {
        const id = (cells[0].textContent ?? "").trim();
        if (id && !/terminal\s*id/i.test(id)) ids.push(id);
      }
    });
    return [...new Set(ids)];
  });
}

// ---------------------------------------------------------------------------
// Step 3: Process a batch of terminals on one page (sequential within page)
// ---------------------------------------------------------------------------

async function processChunk(page: Page, terminalIds: string[]): Promise<(ColumbusTerminalStatus | null)[]> {
  const results: (ColumbusTerminalStatus | null)[] = [];

  // Navigate to TermIDStatus.aspx once per worker page
  page.goto(TERM_STATUS_URL).catch(() => {});
  await page
    .waitForSelector("#Table2, input[id*='radTerminalSelector']", { timeout: 30_000 })
    .catch(() => {});

  for (const termId of terminalIds) {
    try {
      const data = await scrapeTerminal(page, termId);
      results.push(data);
      logger.info({ termId, ok: data !== null }, "Columbus Data: scraped terminal");
    } catch (err) {
      logger.warn({ termId, err: (err as Error).message }, "Columbus Data: terminal scrape failed");
      results.push(null);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scrape one terminal: try URL param, fall back to dropdown
// ---------------------------------------------------------------------------

async function scrapeTerminal(page: Page, termId: string): Promise<ColumbusTerminalStatus | null> {
  // Attempt 1: URL parameter navigation
  page.goto(`${TERM_STATUS_URL}?TermID=${encodeURIComponent(termId)}`).catch(() => {});
  const appeared = await page.waitForSelector("#Table2", { timeout: 12_000 })
    .then(() => true).catch(() => false);

  if (appeared) {
    const idInPage = await page.evaluate(() => {
      const rows = document.querySelector("#Table2")?.querySelectorAll("tr");
      return (rows?.[2]?.querySelectorAll("td")?.[0]?.textContent ?? "").trim();
    });
    if (idInPage === termId) {
      return extractTerminalData(page, termId);
    }
    logger.debug({ termId, found: idInPage }, "Columbus Data: URL param ignored, falling back to dropdown");
  }

  // Attempt 2: Telerik dropdown + Get Status button
  const selected = await selectViaDropdown(page, termId);
  if (!selected) {
    logger.warn({ termId }, "Columbus Data: could not select terminal via dropdown");
    return null;
  }
  return extractTerminalData(page, termId);
}

async function selectViaDropdown(page: Page, termId: string): Promise<boolean> {
  const inputSel = "input[id*='radTerminalSelector_Input'], input[id*='TerminalSelector_Input']";
  const input = await page.$(inputSel);
  if (!input) return false;

  // Clear the current value and type the terminal ID to filter
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input.type(termId, { delay: 40 });
  await new Promise(r => setTimeout(r, 1_500));

  // Click the matching dropdown item
  const clicked = await page.evaluate((id) => {
    const selectors = [
      "[id*='radTerminalSelector_DropDown'] li",
      "[id*='TerminalSelector_DropDown'] li",
      ".rcbList li",
    ];
    for (const sel of selectors) {
      for (const item of document.querySelectorAll(sel)) {
        if ((item.textContent ?? "").trim().startsWith(id)) {
          (item as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  }, termId);

  if (!clicked) {
    await input.press("Enter");
  }
  await new Promise(r => setTimeout(r, 500));

  // Click Get Status
  const btn = await page.$("#btnGetStatus");
  if (btn) {
    await btn.click();
  } else {
    await page.evaluate(() => {
      const b = document.querySelector<HTMLElement>("input[value*='Status'], button[id*='Status']");
      if (b) b.click();
    });
  }

  // Wait for Table2 to update to show the correct terminal
  try {
    await page.waitForFunction(
      (targetId: string) => {
        const rows = document.querySelector("#Table2")?.querySelectorAll("tr");
        const id = (rows?.[2]?.querySelectorAll("td")?.[0]?.textContent ?? "").trim();
        return id === targetId;
      },
      { timeout: 15_000 },
      termId,
    );
    return true;
  } catch {
    logger.warn({ termId }, "Columbus Data: Table2 did not update after dropdown selection");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extract data from Table2 + Table3 (known fixed column positions)
// ---------------------------------------------------------------------------

async function extractTerminalData(page: Page, termId: string): Promise<ColumbusTerminalStatus | null> {
  return page.evaluate((targetId) => {
    function cell(el: Element | null | undefined): string {
      return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    function parseDollar(raw: string): number | null {
      const n = parseFloat(raw.replace(/[$,\s]/g, ""));
      return isNaN(n) ? null : n;
    }

    // Table2: row[0]=section header, row[1]=column headers, row[2]=data
    const t2 = document.querySelector("#Table2");
    if (!t2) return null;
    const c2 = Array.from(t2.querySelectorAll("tr")[2]?.querySelectorAll("td") ?? []);
    const terminalId = cell(c2[0]);
    if (!terminalId) return null;

    const locationName = cell(c2[1]) || null;
    const address      = cell(c2[2]) || null;
    const city         = cell(c2[3]) || null;
    const state        = cell(c2[4]) || null;
    const postalCode   = cell(c2[5]) || null;
    // c2[6]=Telephone, c2[7]=Contact — captured but not stored in schema yet
    const propertyType = cell(c2[8]) || null;

    // Table3: row[0]=section header, row[1]=column headers, row[2]=data
    let makeModel: string | null = null;
    let currentBalance: number | null = null;
    let lastContact: string | null = null;

    const t3 = document.querySelector("#Table3");
    if (t3) {
      const c3 = Array.from(t3.querySelectorAll("tr")[2]?.querySelectorAll("td") ?? []);
      makeModel = cell(c3[0]) || null;
      // c3[1]=Comm Type
      const balEl = document.querySelector("#curbalid") ?? c3[2];
      currentBalance = parseDollar(cell(balEl ?? undefined));
      // c3[3]=Last Error
      lastContact = cell(c3[4]) || null;
      // c3[5]=Last Message, c3[6]=Last App W/D, c3[7]=Install Date
    }

    const isOnline = (() => {
      if (!lastContact) return false;
      const d = new Date(lastContact);
      return !isNaN(d.getTime()) && Date.now() - d.getTime() < 48 * 3_600_000;
    })();

    return {
      terminalId,
      terminalLabel: locationName ? `${terminalId} - ${locationName}` : terminalId,
      locationName,
      address,
      city,
      state,
      postalCode,
      propertyType,
      makeModel,
      currentBalance,
      lastContact,
      isOnline,
    };
  }, termId);
}
