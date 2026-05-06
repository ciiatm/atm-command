/**
 * Columbus Data Portal Scraper
 *
 * Logs in to https://www.columbusdata.net/cdswebtool/login/login.aspx
 * and scrapes ATM status data for every terminal on the account.
 *
 * Requires: puppeteer (installed as a dependency)
 * On EC2/Linux: chromium-browser must be installed for --no-sandbox to work.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

/**
 * Find the system Chromium/Chrome executable.
 * Checks CHROMIUM_PATH env first, then common binary names via `which`.
 */
function findChromiumExecutable(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "chromium-browser",
    "chromium",
    "google-chrome",
    "google-chrome-stable",
  ];
  for (const bin of candidates) {
    try {
      const p = execSync(`which ${bin} 2>/dev/null`).toString().trim();
      if (p) {
        logger.info({ path: p }, "Columbus Data: found system Chromium");
        return p;
      }
    } catch {
      // not found, try next
    }
  }
  return undefined; // let Puppeteer use its bundled chrome if present
}

const LOGIN_URL =
  "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const STATUS_URL =
  "https://www.columbusdata.net/cdswebtool/TerminalStatus/CurrentTerminalStatus.aspx";

export interface ColumbusTransaction {
  /** Timestamp string from the portal, e.g. "May 5 2026  9:03AM" */
  transactedAt: string;
  /** Masked card number */
  cardNumber: string | null;
  /** Transaction type, e.g. "Withdrawal" */
  transactionType: string | null;
  /** Amount dispensed in dollars */
  amount: number | null;
  /** Portal response, e.g. "Approved" */
  response: string | null;
  /** ATM cash balance after this transaction */
  terminalBalance: number | null;
}

export interface ColumbusTerminalStatus {
  /** Raw terminal ID from the portal, e.g. "L443083" */
  terminalId: string;
  /** Display name from the dropdown, e.g. "L443083 - SHEPS BAR & GRILL" */
  terminalLabel: string;
  /** Current cash balance in dollars (parsed from "$6,700.00") */
  currentBalance: number | null;
  /** Surcharge amount in dollars */
  surcharge: number | null;
  /** Last contact timestamp string as shown on page */
  lastContact: string | null;
  /** Make/model string from Table3 */
  makeModel: string | null;
  /** Cash dispensed today in dollars */
  dailyCashDispensed: number | null;
  /** Total transactions today */
  dailyTransactionCount: number | null;
  /** Is the ATM reachable/online based on last contact recency */
  isOnline: boolean;
  /** Individual transactions from Table5 (today's activity) */
  transactions: ColumbusTransaction[];
}

/**
 * Scrape all terminals from Columbus Data for the given credentials.
 * Returns an array of terminal status objects.
 */
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
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
      executablePath,
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(60_000);
    await page.setDefaultTimeout(30_000);

    // -----------------------------------------------------------------------
    // Step 1: Login
    // -----------------------------------------------------------------------
    logger.info("Columbus Data: navigating to login page");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });

    // Dump all input field IDs/names so we can debug selector issues
    const inputFields = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input")).map((el) => ({
        id: el.id,
        name: el.name,
        type: el.type,
      })),
    );
    logger.info({ inputFields }, "Columbus Data: login page inputs");

    // Find username field — try specific IDs first, then fall back to
    // the first visible text/email input on the page
    const userSelector = await findInputSelector(page, [
      "#txtUserName",
      "#txtUsername",
      "#UserName",
      "input[name*='UserName']",
      "input[name*='userName']",
      "input[name*='username']",
      "input[type='text']:not([type='hidden'])",
      "input[type='email']",
    ]);
    if (!userSelector) throw new Error("Columbus Data: could not find username field on login page");

    const passSelector = await findInputSelector(page, [
      "#txtPassword",
      "#Password",
      "input[name*='Password']",
      "input[name*='password']",
      "input[type='password']",
    ]);
    if (!passSelector) throw new Error("Columbus Data: could not find password field on login page");

    // Find submit button
    const submitSelector = await findInputSelector(page, [
      "#btnLogin",
      "#btnSubmit",
      "input[type='submit']",
      "button[type='submit']",
      "input[value*='Login']",
      "input[value*='Sign']",
    ]);
    if (!submitSelector) throw new Error("Columbus Data: could not find login button");

    logger.info({ userSelector, passSelector, submitSelector }, "Columbus Data: found login fields");

    await page.type(userSelector, username, { delay: 30 });
    await page.type(passSelector, password, { delay: 30 });

    // Click login and wait for navigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click(submitSelector),
    ]);

    const currentUrl = page.url();
    logger.info({ currentUrl }, "Columbus Data: after login");

    // Detect login failure — still on a login-like URL
    if (/login|Login|signin|SignIn/i.test(currentUrl)) {
      const errorEl = await page.$(".errormessage, .error, #lblError, .alert, .message");
      const errorText = errorEl
        ? await page.evaluate((el) => el.textContent?.trim(), errorEl)
        : "Still on login page — check credentials";
      throw new Error(`Columbus Data login failed: ${errorText}`);
    }

    // -----------------------------------------------------------------------
    // Step 2: Navigate to Terminal Status page
    // -----------------------------------------------------------------------
    if (!currentUrl.includes("CurrentTerminalStatus")) {
      logger.info("Columbus Data: navigating to terminal status page");
      await page.goto(STATUS_URL, { waitUntil: "networkidle2" });
    }

    // -----------------------------------------------------------------------
    // Step 3: Get all terminal IDs from the dropdown
    // -----------------------------------------------------------------------
    await page.waitForSelector("#cbsTerminals_radTerminalSelector_DropDown", {
      visible: true,
      timeout: 15_000,
    }).catch(() => {
      // Fallback: try to wait for the hidden state input
      return page.waitForSelector(
        "input[id*='radTerminalSelector_ClientState']",
        { timeout: 10_000 },
      );
    });

    const terminals = await extractTerminalList(page);
    logger.info({ count: terminals.length }, "Columbus Data: found terminals");

    if (terminals.length === 0) {
      throw new Error("Columbus Data: no terminals found in dropdown");
    }

    // -----------------------------------------------------------------------
    // Step 4: Iterate through each terminal and scrape status
    // -----------------------------------------------------------------------
    const results: ColumbusTerminalStatus[] = [];

    for (let i = 0; i < terminals.length; i++) {
      const { id: termId, label: termLabel } = terminals[i];
      logger.info(
        { termId, index: i + 1, total: terminals.length },
        "Columbus Data: scraping terminal",
      );

      try {
        // Select the terminal in the dropdown by setting ClientState + triggering postback
        await selectTerminal(page, termId, termLabel);

        // Click "Get Status" button
        await Promise.all([
          waitForAjaxComplete(page),
          page.click("#btnGetStatus").catch(() =>
            // Some pages auto-load on terminal select; if no button, just wait
            waitForAjaxComplete(page),
          ),
        ]);

        // Give Telerik RadAjax a moment to fully render
        await page.waitForTimeout(1_500);

        const status = await scrapeTerminalStatus(page, termId, termLabel);
        results.push(status);
      } catch (err) {
        logger.warn(
          { termId, err: err instanceof Error ? err.message : String(err) },
          "Columbus Data: failed to scrape terminal, skipping",
        );
        results.push({
          terminalId: termId,
          terminalLabel: termLabel,
          currentBalance: null,
          surcharge: null,
          lastContact: null,
          makeModel: null,
          dailyCashDispensed: null,
          dailyTransactionCount: null,
          isOnline: false,
          transactions: [],
        });
      }
    }

    return results;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try each selector in order; return the first one that matches a visible
 * element on the page, or null if none match.
 */
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
    } catch {
      // selector syntax error or element not found, try next
    }
  }
  return null;
}

interface TerminalRef {
  id: string;
  label: string;
}

/**
 * Extract all terminal IDs from the Telerik RadComboBox dropdown.
 * The dropdown list items are rendered as <li> elements inside
 * #cbsTerminals_radTerminalSelector_DropDown.
 */
async function extractTerminalList(page: Page): Promise<TerminalRef[]> {
  // Primary method: read <li> items from the Telerik dropdown list
  const fromLi = await page.evaluate(() => {
    const items = document.querySelectorAll(
      "#cbsTerminals_radTerminalSelector_DropDown li[id]",
    );
    const result: { id: string; label: string }[] = [];
    items.forEach((li) => {
      const text = (li.textContent || "").trim();
      // The value is the terminal ID — it's the first token before " - "
      const match = text.match(/^(\S+)/);
      const id = match ? match[1] : text;
      if (id) result.push({ id, label: text });
    });
    return result;
  });

  if (fromLi.length > 0) return fromLi;

  // Fallback: parse the hidden ClientState JSON
  const fromClientState = await page.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll("input[type=hidden]"),
    ) as HTMLInputElement[];
    for (const input of inputs) {
      if (input.id?.includes("radTerminalSelector_ClientState")) {
        try {
          const parsed = JSON.parse(input.value);
          // ClientState is for the SELECTED item; we need the full list.
          // Return whatever terminal is current so we at least get one.
          if (parsed?.value && parsed?.text) {
            return [{ id: parsed.value as string, label: parsed.text as string }];
          }
        } catch {
          // ignore
        }
      }
    }
    return [];
  });

  return fromClientState;
}

/**
 * Select a terminal via the Telerik RadComboBox.
 * Sets the ClientState hidden input and triggers the combobox change event.
 */
async function selectTerminal(
  page: Page,
  termId: string,
  termLabel: string,
): Promise<void> {
  await page.evaluate(
    (id, label) => {
      // Find and update the hidden ClientState input
      const inputs = Array.from(
        document.querySelectorAll("input[type=hidden]"),
      ) as HTMLInputElement[];
      for (const input of inputs) {
        if (input.id?.includes("radTerminalSelector_ClientState")) {
          input.value = JSON.stringify({
            value: id,
            text: label,
            logEntries: [],
            enabled: true,
            checkedIndices: [],
            checkedItemsTextOverFlow: "",
          });
          break;
        }
      }

      // Also update the visible input (RadComboBox text box)
      const visibleInput = document.querySelector(
        "input[id*='radTerminalSelector_Input']",
      ) as HTMLInputElement | null;
      if (visibleInput) {
        visibleInput.value = label;
      }

      // Try clicking the matching <li> if visible
      const li = Array.from(
        document.querySelectorAll(
          "#cbsTerminals_radTerminalSelector_DropDown li",
        ),
      ).find((el) => el.textContent?.trim().startsWith(id));
      if (li) {
        (li as HTMLElement).click();
      }
    },
    termId,
    termLabel,
  );

  // Small pause so the combobox change handler fires
  await page.waitForTimeout(500);
}

/**
 * Wait for any pending Telerik RadAjax request to finish.
 */
async function waitForAjaxComplete(page: Page, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = await page
      .evaluate(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ajax = (window as any).Telerik?.Web?.UI?.RadAjaxManager;
          if (ajax) return false; // Can't easily check — just continue
          const spinner = document.querySelector(".loading, .spinner, .ajaxLoading");
          return spinner !== null;
        } catch {
          return false;
        }
      })
      .catch(() => false);

    if (!busy) break;
    await page.waitForTimeout(300);
  }
  // Always give the DOM a moment to settle
  await page.waitForTimeout(500);
}

/**
 * Scrape the terminal status and individual transactions from the current page state.
 */
async function scrapeTerminalStatus(
  page: Page,
  termId: string,
  termLabel: string,
): Promise<ColumbusTerminalStatus> {
  return await page.evaluate(
    (termId, termLabel) => {
      function cellText(cell: Element): string {
        return (cell.textContent || "").replace(/ /g, " ").trim();
      }

      function queryText(selector: string): string | null {
        const el = document.querySelector(selector);
        return el ? cellText(el) : null;
      }

      function parseDollar(raw: string | null): number | null {
        if (!raw) return null;
        const cleaned = raw.replace(/[$,\s]/g, "");
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
      }

      // ------------------------------------------------------------------
      // Current balance: <td id="curbalid" class="tmdata">$6,700.00</td>
      // ------------------------------------------------------------------
      const currentBalance = parseDollar(queryText("#curbalid"));

      // ------------------------------------------------------------------
      // Surcharge: "Current Surcharge: $3.50"
      // ------------------------------------------------------------------
      const surchargeRaw = queryText("#litCurrentSurchargePanel");
      let surcharge: number | null = null;
      if (surchargeRaw) {
        const m = surchargeRaw.match(/\$([\d,.]+)/);
        surcharge = m ? parseFloat(m[1].replace(",", "")) : null;
      }

      // ------------------------------------------------------------------
      // Table3: machine info row
      // Columns: Make/Model | Serial | Balance | Surcharge | Last Contact | ...
      // ------------------------------------------------------------------
      let makeModel: string | null = null;
      let lastContact: string | null = null;

      const table3 = document.querySelector("#Table3");
      if (table3) {
        const rows = table3.querySelectorAll("tr");
        if (rows.length >= 2) {
          const cells = rows[1].querySelectorAll("td");
          if (cells[0]) makeModel = cellText(cells[0]) || null;
          // Last contact is the 5th cell (index 4)
          if (cells[4]) lastContact = cellText(cells[4]) || null;
        }
      }

      // ------------------------------------------------------------------
      // Table4: daily totals row
      // Columns: Cash Disp | Total Trans | App W/D
      // ------------------------------------------------------------------
      let dailyCashDispensed: number | null = null;
      let dailyTransactionCount: number | null = null;

      const table4 = document.querySelector("#Table4");
      if (table4) {
        const rows = table4.querySelectorAll("tr");
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 2) {
            dailyCashDispensed = parseDollar(cellText(cells[0]));
            dailyTransactionCount = parseInt(cellText(cells[1]), 10) || null;
            break;
          }
        }
      }

      // ------------------------------------------------------------------
      // Table5: individual transactions
      // Columns: Date/Time | Card # | Type | Amount | Response | Terminal Bal
      // Data rows have td.tmDataGrid cells
      // ------------------------------------------------------------------
      const transactions: {
        transactedAt: string;
        cardNumber: string | null;
        transactionType: string | null;
        amount: number | null;
        response: string | null;
        terminalBalance: number | null;
      }[] = [];

      const table5 = document.querySelector("#Table5");
      if (table5) {
        const rows = table5.querySelectorAll("tr");
        for (let i = 0; i < rows.length; i++) {
          // Transaction data rows have td.tmDataGrid cells
          const cells = rows[i].querySelectorAll("td.tmDataGrid");
          if (cells.length >= 5) {
            const transactedAt = cellText(cells[0]);
            const cardNumber = cellText(cells[1]) || null;
            const transactionType = cellText(cells[2]) || null;
            const amount = parseDollar(cellText(cells[3]));
            const response = cellText(cells[4]) || null;
            // Terminal balance is the 6th column (index 5) if present
            const terminalBalance = cells[5] ? parseDollar(cellText(cells[5])) : null;

            if (transactedAt) {
              transactions.push({
                transactedAt,
                cardNumber,
                transactionType,
                amount,
                response,
                terminalBalance,
              });
            }
          }
        }
      }

      // ------------------------------------------------------------------
      // Online status: last contact within 24 hours
      // ------------------------------------------------------------------
      let isOnline = false;
      if (lastContact) {
        const contactDate = new Date(lastContact);
        if (!isNaN(contactDate.getTime())) {
          isOnline = Date.now() - contactDate.getTime() < 24 * 60 * 60 * 1000;
        }
      }

      return {
        terminalId: termId,
        terminalLabel: termLabel,
        currentBalance,
        surcharge,
        lastContact,
        makeModel,
        dailyCashDispensed,
        dailyTransactionCount,
        isOnline,
        transactions,
      };
    },
    termId,
    termLabel,
  );
}
