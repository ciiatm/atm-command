/**
 * Columbus Data Transaction Scraper (Scraper 2)
 *
 * Scrapes per-terminal transaction history from:
 *   ReportViewer.aspx?reportname=rptTransactionDetailByTIDWithBalance
 *
 * Triggered on-demand from the Transactions page (not during normal sync).
 * Uses CONCURRENCY parallel pages to keep total time reasonable.
 *
 * Fields: Terminal DateTime, Tran Type, Card Number, Amt Reqd,
 *         Fee Reqd, Amt Disp, Fee Amt, Term Seq, Response
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const TX_REPORT_BASE = "https://www.columbusdata.net/cdswebtool/includes/ReportViewer.aspx";
const TX_REPORT_NAME = "rptTransactionDetailByTIDWithBalance";
const CONCURRENCY = 4;

export interface ColumbusTransactionRecord {
  terminalId: string;
  transactedAt: string;
  transactionType: string | null;
  cardNumber: string | null;
  amountRequested: number | null;
  feeRequested: number | null;
  amountDispensed: number | null;
  feeAmount: number | null;
  termSeq: string | null;
  response: string | null;
}

function findChromiumExecutable(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
  for (const bin of candidates) {
    try {
      const p = execSync(`which ${bin} 2>/dev/null`).toString().trim();
      if (p) return p;
    } catch {}
  }
  return undefined;
}

/**
 * Scrape transactions for all provided terminal IDs.
 * Returns a map of terminalId → ColumbusTransactionRecord[]
 */
export async function scrapeColumbusTransactions(
  username: string,
  password: string,
  terminalIds: string[],
): Promise<Map<string, ColumbusTransactionRecord[]>> {
  let browser: Browser | null = null;
  try {
    const executablePath = findChromiumExecutable();
    logger.info({ executablePath: executablePath ?? "puppeteer-bundled", terminals: terminalIds.length }, "Columbus Tx: launching browser");

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--single-process"],
      executablePath,
    });

    // Login
    const loginPage = await browser.newPage();
    loginPage.setDefaultNavigationTimeout(60_000);
    loginPage.setDefaultTimeout(30_000);

    logger.info("Columbus Tx: logging in");
    await loginPage.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await loginPage.waitForSelector("#UsernameTextbox", { visible: true });
    await loginPage.type("#UsernameTextbox", username, { delay: 30 });
    await loginPage.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      loginPage.waitForNavigation({ waitUntil: "domcontentloaded" }),
      loginPage.click("#LoginButton"),
    ]);
    if (/login/i.test(loginPage.url())) {
      throw new Error("Columbus Tx login failed — check credentials");
    }
    await loginPage.close();

    // Open worker pages and distribute terminal IDs
    const workerPages: Page[] = [];
    for (let i = 0; i < Math.min(CONCURRENCY, terminalIds.length); i++) {
      const p = await browser.newPage();
      p.setDefaultNavigationTimeout(60_000);
      p.setDefaultTimeout(30_000);
      workerPages.push(p);
    }

    const chunks: string[][] = Array.from({ length: workerPages.length }, () => []);
    terminalIds.forEach((id, i) => chunks[i % workerPages.length].push(id));

    const chunkResults = await Promise.all(
      workerPages.map((wp, i) => scrapeTransactionChunk(wp, chunks[i]))
    );

    // Merge all results into one map
    const result = new Map<string, ColumbusTransactionRecord[]>();
    for (const chunk of chunkResults) {
      for (const [termId, records] of chunk) {
        result.set(termId, records);
      }
    }

    logger.info({ terminals: result.size }, "Columbus Tx: scrape complete");
    return result;

  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Process a chunk of terminal IDs on one page
// ---------------------------------------------------------------------------

async function scrapeTransactionChunk(
  page: Page,
  terminalIds: string[],
): Promise<Map<string, ColumbusTransactionRecord[]>> {
  const result = new Map<string, ColumbusTransactionRecord[]>();

  for (const termId of terminalIds) {
    try {
      const records = await scrapeTerminalTransactions(page, termId);
      result.set(termId, records);
      logger.info({ termId, count: records.length }, "Columbus Tx: scraped terminal");
    } catch (err) {
      logger.warn({ termId, err: (err as Error).message }, "Columbus Tx: terminal failed");
      result.set(termId, []);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scrape transactions for a single terminal
// ---------------------------------------------------------------------------

async function scrapeTerminalTransactions(
  page: Page,
  termId: string,
): Promise<ColumbusTransactionRecord[]> {
  // Try with TermID query param; SSRS-style reports often support this
  const url = `${TX_REPORT_BASE}?reportname=${TX_REPORT_NAME}&TermID=${encodeURIComponent(termId)}`;
  page.goto(url).catch(() => {});

  // Wait for any table to appear
  const tableAppeared = await page.waitForSelector("table", { timeout: 20_000 })
    .then(() => true).catch(() => false);

  // Click "View Report" / submit button if present (report may need explicit trigger)
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
    await page.waitForSelector("table", { timeout: 20_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3_000));
  }

  // Parse transaction table from main frame or any iframe
  const parseTable = async (ctx: Page | import("puppeteer").Frame) => {
    return ctx.evaluate((tid) => {
      function cell(el: Element | null | undefined): string {
        return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function parseDollar(raw: string): number | null {
        const n = parseFloat(raw.replace(/[$,\s]/g, ""));
        return isNaN(n) ? null : n;
      }

      // Find the most data-rich transaction table
      const tables = Array.from(document.querySelectorAll("table"));
      let best: HTMLTableElement | null = null;
      for (const t of tables) {
        const text = (t.textContent ?? "").toLowerCase();
        if ((text.includes("tran") || text.includes("card")) && text.includes("amt") && t.rows.length > 2) {
          if (!best || t.rows.length > best.rows.length) best = t;
        }
      }
      if (!best) return null;

      const allRows = Array.from(best.querySelectorAll("tr"));

      // Find the header row
      const headerRow = allRows.find(r => {
        const t = (r.textContent ?? "").toLowerCase().replace(/\s+/g, "");
        return t.includes("tran") && (t.includes("amt") || t.includes("card"));
      });
      if (!headerRow) return null;

      const headers = Array.from(headerRow.querySelectorAll("th, td"))
        .map(h => cell(h).toLowerCase().replace(/\s+/g, ""));

      const idx = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));

      // Map the report columns
      const dateIdx     = idx("datetime") !== -1 ? idx("datetime") : idx("date") !== -1 ? idx("date") : 0;
      const typeIdx     = idx("trantype") !== -1 ? idx("trantype") : idx("type") !== -1 ? idx("type") : -1;
      const cardIdx     = idx("card") !== -1 ? idx("card") : -1;
      const amtReqdIdx  = idx("amtreqd") !== -1 ? idx("amtreqd") : idx("amtrequested") !== -1 ? idx("amtrequested") : -1;
      const feeReqdIdx  = idx("feereqd") !== -1 ? idx("feereqd") : idx("feelrequested") !== -1 ? idx("feelrequested") : -1;
      const amtDispIdx  = idx("amtdisp") !== -1 ? idx("amtdisp") : idx("amtdispensed") !== -1 ? idx("amtdispensed") : -1;
      const feeAmtIdx   = idx("feeamt") !== -1 ? idx("feeamt") : idx("feeamount") !== -1 ? idx("feeamount") : -1;
      const termSeqIdx  = idx("termseq") !== -1 ? idx("termseq") : idx("seq") !== -1 ? idx("seq") : -1;
      const responseIdx = idx("response") !== -1 ? idx("response") : -1;

      const records: {
        terminalId: string;
        transactedAt: string;
        transactionType: string | null;
        cardNumber: string | null;
        amountRequested: number | null;
        feeRequested: number | null;
        amountDispensed: number | null;
        feeAmount: number | null;
        termSeq: string | null;
        response: string | null;
      }[] = [];

      const headerIdx2 = allRows.indexOf(headerRow);
      for (let i = headerIdx2 + 1; i < allRows.length; i++) {
        const cells = Array.from(allRows[i].querySelectorAll("td"));
        if (cells.length < 2) continue;
        const dateRaw = cells[dateIdx] ? cell(cells[dateIdx]) : "";
        if (!dateRaw) continue;

        records.push({
          terminalId: tid,
          transactedAt: dateRaw,
          transactionType: typeIdx >= 0 && cells[typeIdx] ? cell(cells[typeIdx]) || null : null,
          cardNumber:      cardIdx >= 0 && cells[cardIdx] ? cell(cells[cardIdx]) || null : null,
          amountRequested: amtReqdIdx >= 0 && cells[amtReqdIdx] ? parseDollar(cell(cells[amtReqdIdx])) : null,
          feeRequested:    feeReqdIdx >= 0 && cells[feeReqdIdx] ? parseDollar(cell(cells[feeReqdIdx])) : null,
          amountDispensed: amtDispIdx >= 0 && cells[amtDispIdx] ? parseDollar(cell(cells[amtDispIdx])) : null,
          feeAmount:       feeAmtIdx >= 0 && cells[feeAmtIdx] ? parseDollar(cell(cells[feeAmtIdx])) : null,
          termSeq:         termSeqIdx >= 0 && cells[termSeqIdx] ? cell(cells[termSeqIdx]) || null : null,
          response:        responseIdx >= 0 && cells[responseIdx] ? cell(cells[responseIdx]) || null : null,
        });
      }

      return records.length > 0 ? records : null;
    }, tid);
  };

  let rows = await parseTable(page).catch(() => null);
  if (!rows) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      rows = await parseTable(frame as any).catch(() => null);
      if (rows) break;
    }
  }

  logger.info({ termId, count: rows?.length ?? 0 }, "Columbus Tx: terminal transactions scraped");
  return rows ?? [];
}
