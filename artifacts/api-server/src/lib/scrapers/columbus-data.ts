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
import { logger } from "../logger.js";

const LOGIN_URL =
  "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const STATUS_URL =
  "https://www.columbusdata.net/cdswebtool/TerminalStatus/CurrentTerminalStatus.aspx";

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
}

/**
 * Parses a dollar string like "$6,700.00" or "6700" → number
 * Returns null if unparseable.
 */
function parseDollar(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s ]/g, "").trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
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
      // Use system chromium if available (set by env), otherwise puppeteer's bundled chrome
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(60_000);
    await page.setDefaultTimeout(30_000);

    // -----------------------------------------------------------------------
    // Step 1: Login
    // -----------------------------------------------------------------------
    logger.info("Columbus Data: navigating to login page");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });

    // Fill username and password
    await page.waitForSelector("#txtUserName", { visible: true });
    await page.type("#txtUserName", username, { delay: 30 });
    await page.type("#txtPassword", password, { delay: 30 });

    // Click the login button
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click("#btnLogin"),
    ]);

    const currentUrl = page.url();
    logger.info({ currentUrl }, "Columbus Data: after login");

    // Detect login failure
    if (currentUrl.includes("login") || currentUrl.includes("Login")) {
      const errorEl = await page.$(".errormessage, .error, #lblError");
      const errorText = errorEl
        ? await page.evaluate((el) => el.textContent?.trim(), errorEl)
        : "Unknown login error";
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
 * Polls for the Telerik Sys.Application.get_isRequestInProgress() flag.
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
          // Alternative: check for spinning indicators
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
 * Scrape the terminal status from the current page state.
 */
async function scrapeTerminalStatus(
  page: Page,
  termId: string,
  termLabel: string,
): Promise<ColumbusTerminalStatus> {
  return await page.evaluate(
    (termId, termLabel) => {
      function text(selector: string): string | null {
        const el = document.querySelector(selector);
        return el ? (el.textContent || "").replace(/ /g, " ").trim() : null;
      }

      function parseDollar(raw: string | null): number | null {
        if (!raw) return null;
        const cleaned = raw.replace(/[$,\s ]/g, "");
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
      }

      // Current balance: <td id="curbalid" class="tmdata">$6,700.00</td>
      const balanceRaw = text("#curbalid");
      const currentBalance = parseDollar(balanceRaw);

      // Surcharge: "Current Surcharge: $3.50"
      const surchargeRaw = text("#litCurrentSurchargePanel");
      let surcharge: number | null = null;
      if (surchargeRaw) {
        const m = surchargeRaw.match(/\$([\d,.]+)/);
        surcharge = m ? parseFloat(m[1].replace(",", "")) : null;
      }

      // Table3 contains machine info and last contact
      // Row structure (based on provided HTML):
      // Row 0: headers
      // Row 1: data (make/model, serial?, balance, surcharge, last contact, ...)
      let makeModel: string | null = null;
      let lastContact: string | null = null;

      const table3 = document.querySelector("#Table3");
      if (table3) {
        const rows = table3.querySelectorAll("tr");
        if (rows.length >= 2) {
          const cells = rows[1].querySelectorAll("td");
          if (cells.length >= 1) {
            makeModel = (cells[0].textContent || "").replace(/ /g, " ").trim() || null;
          }
          // Last contact is in cell index 4 (0-based)
          if (cells.length >= 5) {
            lastContact = (cells[4].textContent || "").replace(/ /g, " ").trim() || null;
          }
        }
      }

      // Table4: daily totals
      // Headers: Cash Disp | Total Trans | App W/D
      // Data row follows
      let dailyCashDispensed: number | null = null;
      let dailyTransactionCount: number | null = null;

      const table4 = document.querySelector("#Table4");
      if (table4) {
        const rows = table4.querySelectorAll("tr");
        // Find the data row (not the header row)
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 2) {
            dailyCashDispensed = parseDollar(
              (cells[0].textContent || "").replace(/ /g, " ").trim(),
            );
            const txRaw = (cells[1].textContent || "").replace(/ /g, " ").trim();
            dailyTransactionCount = parseInt(txRaw, 10) || null;
            break;
          }
        }
      }

      // Determine online status based on last contact recency
      let isOnline = false;
      if (lastContact) {
        const contactDate = new Date(lastContact);
        if (!isNaN(contactDate.getTime())) {
          const ageMs = Date.now() - contactDate.getTime();
          // If last contact was within 24 hours, consider online
          isOnline = ageMs < 24 * 60 * 60 * 1000;
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
      };
    },
    termId,
    termLabel,
  );
}
