/**
 * Columbus Data Transaction Scraper
 *
 * Uses the "Online Transaction Journals" page (journal.aspx) instead of the
 * SSRS-based ReportViewer.aspx which is permanently blocked (302 → 404).
 *
 * Strategy:
 *   - ONE browser, ONE page, sequential terminals (avoids --single-process crashes)
 *   - Navigate to journal.aspx for each terminal
 *   - Select terminal via Telerik RadComboBox (LoadOnDemand: type → wait → click)
 *   - Set date range via Telerik RadDatePicker set_selectedDate() JS API
 *   - Submit with __EVENTTARGET=lnkView + Form1.submit() (avoids strict-mode error)
 *   - Extract Table1 text content and parse into ColumbusTransactionRecord[]
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const LOGIN_URL    = "https://www.columbusdata.net/cdswebtool/login/login.aspx";
const JOURNAL_URL  = "https://www.columbusdata.net/cdswebtool/TerminalMonitoring/journal.aspx";

// Real-browser user-agent (Chrome 124 on macOS)
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

function formatDate(d: Date): string {
  const m   = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}/${day}/${d.getFullYear()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function scrapeColumbusTransactions(
  username: string,
  password: string,
  terminalIds: string[],
): Promise<Map<string, ColumbusTransactionRecord[]>> {
  let browser: Browser | null = null;
  const result = new Map<string, ColumbusTransactionRecord[]>();

  try {
    const executablePath = findChromiumExecutable();
    logger.info({ executablePath: executablePath ?? "bundled", count: terminalIds.length }, "Columbus Tx: launching browser");

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
    await page.setUserAgent(CHROME_UA);
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(90_000);
    page.setDefaultTimeout(30_000);

    // ── Bypass bot detection ───────────────────────────────────────────────
    // Puppeteer sets navigator.webdriver=true which SSRS JS detects and
    // redirects to cdsatm.com (marketing site) instead of rendering the report.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // Also spoof a realistic plugins list (headless has 0 plugins)
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    // ── Login ──────────────────────────────────────────────────────────────
    logger.info("Columbus Tx: logging in");
    await page.goto(LOGIN_URL, { waitUntil: "load" });
    await page.waitForSelector("#UsernameTextbox", { visible: true });
    await page.type("#UsernameTextbox", username, { delay: 30 });
    await page.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.click("#LoginButton"),
    ]);
    if (/login/i.test(page.url())) {
      throw new Error("Columbus Tx: login failed");
    }
    logger.info("Columbus Tx: login ok");

    // ── Scrape terminals sequentially ─────────────────────────────────────
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 60);
    const startStr = formatDate(start);
    const endStr   = formatDate(end);

    for (const termId of terminalIds) {
      try {
        const records = await scrapeOneTerminal(page, termId, startStr, endStr);
        result.set(termId, records);
        logger.info({ termId, count: records.length }, "Columbus Tx: terminal done");
      } catch (err) {
        logger.warn({ termId, err: (err as Error).message }, "Columbus Tx: terminal failed");
        result.set(termId, []);
      }
    }

  } finally {
    await browser?.close().catch(() => {});
  }

  logger.info({ total: result.size }, "Columbus Tx: complete");
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrape one terminal via journal.aspx (Online Transaction Journals)
//
// The SSRS-based ReportViewer.aspx approach is permanently blocked (302 → 404).
// journal.aspx is a standard ASP.NET WebForms page with Telerik controls that
// returns per-transaction journal data without SSRS.
//
// Flow:
//   1. Navigate to journal.aspx
//   2. Type terminal ID into Telerik RadComboBox (triggers AJAX LoadOnDemand)
//   3. Wait for .rcbItem dropdown items → click matching item + JS-select
//   4. Set date range via Telerik RadDatePicker set_selectedDate() JS API
//   5. Submit via __EVENTTARGET=lnkView + Form1.submit() (avoids strict-mode error)
//   6. Extract Table1 text content → parseJournalText()
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeOneTerminal(
  page: Page,
  termId: string,
  startStr: string,   // "MM/DD/YYYY"
  endStr:   string,
): Promise<ColumbusTransactionRecord[]> {
  logger.debug({ termId }, "Columbus Tx: navigating to journal.aspx");
  await page.goto(JOURNAL_URL, { waitUntil: "load" });

  // Wait for Telerik JS to initialise ($find becomes available)
  await page.waitForFunction(() => !!(window as any).$find, { timeout: 10_000 }).catch(() => null);
  await sleep(500);

  // ── 1. Select terminal in RadComboBox (LoadOnDemand) ──────────────────────
  const comboInput = await page.$("#cbsTerminals_radTerminalSelector_Input");
  if (comboInput) {
    // Clear the input and type the terminal ID to trigger AJAX item load
    await page.click("#cbsTerminals_radTerminalSelector_Input");
    await page.evaluate(() => {
      const el = document.getElementById("cbsTerminals_radTerminalSelector_Input") as HTMLInputElement;
      if (el) { el.value = ""; el.select(); }
    });
    await page.type("#cbsTerminals_radTerminalSelector_Input", termId, { delay: 80 });
  }

  // Wait for Telerik dropdown DOM items to appear
  await page.waitForSelector(".rcbItem", { timeout: 6_000 }).catch(() => null);
  await sleep(400);

  // Click the matching DOM item
  const domClickResult = await page.evaluate((targetId: string) => {
    const items = Array.from(document.querySelectorAll(".rcbItem, [class*='rcbItem']"));
    const match = items.find(el => el.textContent?.includes(targetId));
    if (match) { (match as HTMLElement).click(); return `clicked: ${match.textContent?.trim()}`; }
    return "no .rcbItem matched";
  }, termId).catch((e: Error) => String(e));

  await sleep(300);

  // Also use Telerik JS API as belt-and-suspenders
  const jsSelectResult = await page.evaluate((targetId: string) => {
    const w = window as any;
    const combo = w.$find?.("cbsTerminals_radTerminalSelector");
    if (!combo) return "combo not found";
    const items = combo.get_items();
    for (let i = 0; i < items.get_count(); i++) {
      const item = items.getItem(i);
      if (item.get_value() === targetId || item.get_text().includes(targetId)) {
        item.select();
        return `JS-selected[${i}]: ${item.get_text()}`;
      }
    }
    // Fallback: craft ClientState directly so the server receives the value
    const input      = document.getElementById("cbsTerminals_radTerminalSelector_Input")      as HTMLInputElement;
    const stateInput = document.getElementById("cbsTerminals_radTerminalSelector_ClientState") as HTMLInputElement;
    if (input && stateInput) {
      input.value      = targetId;
      stateInput.value = JSON.stringify({
        logEntries:      [{ type: 5, index: 0, value: targetId, text: targetId }],
        selectedIndices: [0],
      });
      return `crafted ClientState for ${targetId}`;
    }
    return "no fallback available";
  }, termId).catch((e: Error) => String(e));

  logger.debug({ termId, domClickResult, jsSelectResult }, "Columbus Tx: terminal selection");

  // ── 2. Set date range via Telerik RadDatePicker JS API ────────────────────
  const [startMs, endMs] = [
    (() => { const d = new Date(startStr); d.setHours(0, 0, 0, 0); return d.getTime(); })(),
    (() => { const d = new Date(endStr);   d.setHours(23, 59, 0, 0); return d.getTime(); })(),
  ];

  await page.evaluate((sMs: number, eMs: number) => {
    const w     = window as any;
    const sDate = new Date(sMs);
    const eDate = new Date(eMs);
    const bp    = w.$find?.("txtBeginDateTime1");
    const ep    = w.$find?.("txtEndingDateTime1");
    if (bp) bp.set_selectedDate(sDate);
    if (ep) ep.set_selectedDate(eDate);

    // Belt-and-suspenders: also update raw hidden inputs
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-00`;
    const fmtDisplay = (d: Date) =>
      `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const s = (id: string) => document.getElementById(id) as HTMLInputElement | null;
    if (s("txtBeginDateTime1"))            s("txtBeginDateTime1")!.value            = fmt(sDate);
    if (s("txtBeginDateTime1_dateInput"))  s("txtBeginDateTime1_dateInput")!.value  = fmtDisplay(sDate);
    if (s("txtEndingDateTime1"))           s("txtEndingDateTime1")!.value           = fmt(eDate);
    if (s("txtEndingDateTime1_dateInput")) s("txtEndingDateTime1_dateInput")!.value = fmtDisplay(eDate);
  }, startMs, endMs).catch(() => null);

  await sleep(300);

  // ── 3. Submit form via __EVENTTARGET=lnkView ──────────────────────────────
  // Calling window.__doPostBack() directly from page.evaluate throws a
  // strict-mode TypeError. Setting hidden inputs + form.submit() is equivalent.
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 20_000 }).catch(() => null),
    page.evaluate(() => {
      const t = document.getElementById("__EVENTTARGET")   as HTMLInputElement | null;
      const a = document.getElementById("__EVENTARGUMENT") as HTMLInputElement | null;
      if (t) t.value = "lnkView";
      if (a) a.value = "";
      (document.getElementById("Form1") as HTMLFormElement | null)?.submit();
    }),
  ]);

  // ── 4. Extract journal text from Table1 ───────────────────────────────────
  const tableText = await page.evaluate(() => {
    const t = document.getElementById("Table1");
    return t ? t.textContent ?? "" : "";
  }).catch(() => "");

  logger.debug({ termId, tableTextLen: tableText.length }, "Columbus Tx: journal page loaded");

  const records = parseJournalText(tableText, termId);
  logger.info({ termId, count: records.length }, "Columbus Tx: parsed journal");
  return records;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse journal.aspx Table1 text content → ColumbusTransactionRecord[]
//
// Table1 text is a sequence of transaction blocks separated by "Terminal ID:".
// Each block looks like:
//
//   Terminal ID: L745870
//   Date/Time: 05/15/2026 15:26:23 PM
//   Business Date: 05/15/2026
//   Src Acct: Checking
//   Dest Acct: No Destination Account
//   Seq #: 0567
//   Account #: ************8147
//   Tran Type: Cash Withdrawal
//   Requested: $40.00
//   Dispensed: $40.00
//   Surcharge: $3.60
//   Term Err: 0000000
//   Reversal Status: Transaction
//
// "UNDEFINED JOURNAL" blocks are filtered out.
// ─────────────────────────────────────────────────────────────────────────────

function parseJournalText(text: string, termId: string): ColumbusTransactionRecord[] {
  if (!text.trim()) return [];

  const parseDollar = (s: string | undefined): number | null => {
    if (!s) return null;
    const n = parseFloat(s.replace(/[$,\s]/g, ""));
    return isNaN(n) ? null : n;
  };

  // Field extractor: "Label: value" → value string
  const field = (block: string, label: string): string | null => {
    const re = new RegExp(`${label}\\s*:\\s*(.+?)(?=\\n|$)`, "i");
    const m  = block.match(re);
    return m ? m[1].trim() : null;
  };

  // Split into blocks on every occurrence of "Terminal ID:"
  // The first element before the first occurrence is header/empty — drop it.
  const rawBlocks = text.split(/(?=Terminal ID\s*:)/i).filter(b => b.trim());

  const records: ColumbusTransactionRecord[] = [];

  for (const block of rawBlocks) {
    // Skip undefined journal entries (no real transaction data)
    if (/UNDEFINED JOURNAL/i.test(block)) continue;

    // Must have a Date/Time to be a real transaction
    const dateTimeRaw = field(block, "Date/Time");
    if (!dateTimeRaw) continue;

    // Normalise timestamp: "05/15/2026 15:26:23 PM" → ISO-ish string
    // We store it as-is; callers can convert as needed.
    const transactedAt = dateTimeRaw;

    // Use block's own terminal ID if present, else fall back to the argument
    const blockTermId = field(block, "Terminal ID") ?? termId;

    const tranType    = field(block, "Tran Type");
    const accountRaw  = field(block, "Account #");
    const seqRaw      = field(block, "Seq #");
    const requestedRaw = field(block, "Requested");
    const dispensedRaw = field(block, "Dispensed");
    const surchargeRaw = field(block, "Surcharge");
    const reversalRaw  = field(block, "Reversal Status");

    // Filter out non-dispensing transaction types if completely empty
    if (!tranType && !requestedRaw && !dispensedRaw) continue;

    records.push({
      terminalId:      blockTermId,
      transactedAt,
      transactionType: tranType,
      cardNumber:      accountRaw,
      amountRequested: parseDollar(requestedRaw ?? undefined),
      feeRequested:    null,          // journal doesn't separate fee from surcharge on request side
      amountDispensed: parseDollar(dispensedRaw ?? undefined),
      feeAmount:       parseDollar(surchargeRaw ?? undefined),
      termSeq:         seqRaw,
      response:        reversalRaw,
    });
  }

  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse ASP.NET UpdatePanel response format (kept for reference — no longer used)
// Format: {len}|{type}|{id}|{content}|   (repeating)
// ─────────────────────────────────────────────────────────────────────────────

function parseUpdatePanelResponse(text: string, termId: string): ColumbusTransactionRecord[] {
  // Quick check: does this look like an UpdatePanel response?
  if (!text.match(/^\d+\|/)) return [];

  const htmlSections: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    // Read length
    const pipe1 = text.indexOf("|", pos);
    if (pipe1 < 0) break;
    const len = parseInt(text.substring(pos, pipe1), 10);
    if (isNaN(len)) break;

    // Read type
    const pipe2 = text.indexOf("|", pipe1 + 1);
    if (pipe2 < 0) break;
    const type = text.substring(pipe1 + 1, pipe2);

    // Read id
    const pipe3 = text.indexOf("|", pipe2 + 1);
    if (pipe3 < 0) break;
    // const id = text.substring(pipe2 + 1, pipe3);

    // Read content (exactly `len` characters)
    const contentStart = pipe3 + 1;
    if (contentStart + len > text.length) break;
    const content = text.substring(contentStart, contentStart + len);

    if (type === "updatePanel" && content.includes("<table")) {
      htmlSections.push(content);
    }

    // Skip trailing pipe
    pos = contentStart + len + 1;
  }

  for (const html of htmlSections) {
    const rows = parseTransactionHtml(html, termId);
    if (rows.length > 0) return rows;
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse transaction table from raw HTML string
// ─────────────────────────────────────────────────────────────────────────────

function parseTransactionHtml(html: string, termId: string): ColumbusTransactionRecord[] {
  const stripTags = (s: string) =>
    s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  let best: ColumbusTransactionRecord[] = [];

  for (const tableHtml of tableMatches) {
    const lower = tableHtml.toLowerCase();
    let score = 0;
    if (lower.includes("tran"))     score += 3;
    if (lower.includes("card"))     score += 2;
    if (lower.includes("amt"))      score += 2;
    if (lower.includes("fee"))      score += 1;
    if (lower.includes("response")) score += 1;
    if (score < 4) continue;

    const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    if (rowMatches.length < 2) continue;

    let headerIdx = -1;
    let headers: string[] = [];
    for (let i = 0; i < rowMatches.length; i++) {
      const cellMatches = rowMatches[i].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) ?? [];
      const cellTexts = cellMatches.map(c => stripTags(c).toLowerCase().replace(/\s+/g, ""));
      const joined = cellTexts.join("");
      if ((joined.includes("tran") || joined.includes("datetime")) && (joined.includes("amt") || joined.includes("card"))) {
        headerIdx = i;
        headers = cellTexts;
        break;
      }
    }
    if (headerIdx < 0) continue;

    const idx = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));
    const dateIdx    = idx("datetime") >= 0 ? idx("datetime") : idx("date") >= 0 ? idx("date") : 0;
    const typeIdx    = idx("trantype") >= 0 ? idx("trantype") : idx("type") >= 0 ? idx("type") : -1;
    const cardIdx    = idx("card");
    const amtReqdIdx = idx("amtreqd") >= 0 ? idx("amtreqd") : idx("amtrequested");
    const feeReqdIdx = idx("feereqd") >= 0 ? idx("feereqd") : idx("feelrequested");
    const amtDispIdx = idx("amtdisp") >= 0 ? idx("amtdisp") : idx("amtdispensed");
    const feeAmtIdx  = idx("feeamt")  >= 0 ? idx("feeamt")  : idx("feeamount");
    const seqIdx     = idx("termseq") >= 0 ? idx("termseq") : idx("seq");
    const respIdx    = idx("response");

    const parseDollar = (s: string): number | null => {
      const n = parseFloat(s.replace(/[$,\s]/g, ""));
      return isNaN(n) ? null : n;
    };

    const rows: ColumbusTransactionRecord[] = [];
    for (let i = headerIdx + 1; i < rowMatches.length; i++) {
      const cellMatches = rowMatches[i].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) ?? [];
      const cells = cellMatches.map(c => stripTags(c));
      if (cells.length < 2) continue;
      const dateRaw = cells[dateIdx] ?? "";
      if (!dateRaw || /^total|grand|sub/i.test(dateRaw)) continue;
      const g = (ix: number): string | null => ix >= 0 && cells[ix] ? cells[ix].trim() || null : null;
      rows.push({
        terminalId: termId,
        transactedAt: dateRaw,
        transactionType: g(typeIdx),
        cardNumber: g(cardIdx),
        amountRequested: amtReqdIdx >= 0 ? parseDollar(cells[amtReqdIdx] ?? "") : null,
        feeRequested:    feeReqdIdx >= 0 ? parseDollar(cells[feeReqdIdx] ?? "") : null,
        amountDispensed: amtDispIdx >= 0 ? parseDollar(cells[amtDispIdx] ?? "") : null,
        feeAmount:       feeAmtIdx  >= 0 ? parseDollar(cells[feeAmtIdx]  ?? "") : null,
        termSeq:  g(seqIdx),
        response: g(respIdx),
      });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse transaction table from live DOM (Puppeteer page)
// ─────────────────────────────────────────────────────────────────────────────

async function parseTableFromDom(page: Page, termId: string): Promise<ColumbusTransactionRecord[]> {
  return page.evaluate((tid: string) => {
    function cell(el: Element | null | undefined): string {
      return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    function parseDollar(raw: string): number | null {
      const n = parseFloat(raw.replace(/[$,\s]/g, ""));
      return isNaN(n) ? null : n;
    }

    const tables = Array.from(document.querySelectorAll("table"));
    let best: HTMLTableElement | null = null;
    let bestScore = 0;
    for (const t of tables) {
      const txt = (t.textContent ?? "").toLowerCase();
      let s = 0;
      if (txt.includes("tran")) s += 3;
      if (txt.includes("card")) s += 2;
      if (txt.includes("amt"))  s += 2;
      if (txt.includes("fee"))  s += 1;
      if (s > bestScore && t.rows.length > 2) { bestScore = s; best = t; }
    }
    if (!best || bestScore < 4) return [];

    const allRows = Array.from(best.querySelectorAll("tr"));
    const headerRow = allRows.find(r => {
      const t = (r.textContent ?? "").toLowerCase().replace(/\s+/g, "");
      return (t.includes("tran") || t.includes("datetime")) && (t.includes("amt") || t.includes("card"));
    });
    if (!headerRow) return [];

    const headers = Array.from(headerRow.querySelectorAll("th,td"))
      .map(h => cell(h).toLowerCase().replace(/\s+/g, ""));

    const idx = (kw: string) => headers.findIndex(h => h.includes(kw.replace(/\s+/g, "")));
    const dateIdx    = idx("datetime") >= 0 ? idx("datetime") : idx("date") >= 0 ? idx("date") : 0;
    const typeIdx    = idx("trantype") >= 0 ? idx("trantype") : idx("type") >= 0 ? idx("type") : -1;
    const cardIdx    = idx("card");
    const amtReqdIdx = idx("amtreqd") >= 0 ? idx("amtreqd") : idx("amtrequested");
    const feeReqdIdx = idx("feereqd") >= 0 ? idx("feereqd") : idx("feelrequested");
    const amtDispIdx = idx("amtdisp") >= 0 ? idx("amtdisp") : idx("amtdispensed");
    const feeAmtIdx  = idx("feeamt")  >= 0 ? idx("feeamt")  : idx("feeamount");
    const seqIdx     = idx("termseq") >= 0 ? idx("termseq") : idx("seq");
    const respIdx    = idx("response");

    const result: {terminalId:string;transactedAt:string;transactionType:string|null;cardNumber:string|null;amountRequested:number|null;feeRequested:number|null;amountDispensed:number|null;feeAmount:number|null;termSeq:string|null;response:string|null}[] = [];
    const hi = allRows.indexOf(headerRow);
    for (let i = hi + 1; i < allRows.length; i++) {
      const cells = Array.from(allRows[i].querySelectorAll("td"));
      if (cells.length < 2) continue;
      const dateRaw = cell(cells[dateIdx]);
      if (!dateRaw || /^total|grand|sub/i.test(dateRaw)) continue;
      const g = (ix: number) => ix >= 0 && cells[ix] ? cell(cells[ix]) || null : null;
      result.push({
        terminalId: tid,
        transactedAt: dateRaw,
        transactionType: g(typeIdx),
        cardNumber: g(cardIdx),
        amountRequested: amtReqdIdx >= 0 ? parseDollar(cell(cells[amtReqdIdx])) : null,
        feeRequested:    feeReqdIdx >= 0 ? parseDollar(cell(cells[feeReqdIdx])) : null,
        amountDispensed: amtDispIdx >= 0 ? parseDollar(cell(cells[amtDispIdx])) : null,
        feeAmount:       feeAmtIdx  >= 0 ? parseDollar(cell(cells[feeAmtIdx]))  : null,
        termSeq:  g(seqIdx),
        response: g(respIdx),
      });
    }
    return result;
  }, termId).catch(() => []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug: comprehensive diagnostic for one terminal
// ─────────────────────────────────────────────────────────────────────────────

export async function debugScrapeTerminal(
  username: string,
  password: string,
  termId: string,
): Promise<Record<string, unknown>> {
  let browser: Browser | null = null;
  const diag: Record<string, unknown> = {};

  try {
    const executablePath = findChromiumExecutable();
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--single-process"],
      executablePath,
    });

    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(90_000);

    // Bypass bot detection (same as main scraper)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    // ── Capture console logs and page errors ──────────────────────────────
    const consoleLogs: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", msg => {
      const text = `[${msg.type()}] ${msg.text()}`;
      if (!text.includes("favicon") && !text.includes("404")) {
        consoleLogs.push(text);
      }
    });
    page.on("pageerror", err => pageErrors.push(err.message));

    // ── Capture ALL network requests (not just columbusdata.net) ──────────
    const allRequests: { t: number; method: string; url: string }[] = [];
    page.on("request", (req: HTTPRequest) => {
      const u = req.url();
      // Skip static assets
      if (/\.(css|png|gif|jpg|woff|ico)(\?|$)/i.test(u)) return;
      allRequests.push({ t: Date.now(), method: req.method(), url: u });
    });

    // ── Capture ALL responses (no domain filter) ──────────────────────────
    const allResponses: { t: number; method: string; url: string; status: number; bodyLen: number; snippet: string }[] = [];
    page.on("response", async (resp: HTTPResponse) => {
      const u = resp.url();
      if (/\.(css|png|gif|jpg|woff|ico)(\?|$)/i.test(u)) return;
      try {
        const text = await resp.text().catch(() => "");
        allResponses.push({
          t: Date.now(),
          method: resp.request().method(),
          url: u,
          status: resp.status(),
          bodyLen: text.length,
          snippet: text.substring(0, 800),
        });
      } catch {}
    });

    // ── Login ─────────────────────────────────────────────────────────────
    await page.goto(LOGIN_URL, { waitUntil: "load" });
    await page.waitForSelector("#UsernameTextbox", { visible: true });
    await page.type("#UsernameTextbox", username, { delay: 30 });
    await page.type("#PasswordTextbox", password, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.click("#LoginButton"),
    ]);
    diag.loginOk = !/login/i.test(page.url());
    if (!diag.loginOk) { diag.consoleLogs = consoleLogs; return diag; }

    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 60);

    const url =
      `${REPORT_BASE}?reportname=${REPORT_NAME}` +
      `&TermID=${encodeURIComponent(termId)}` +
      `&StartDate=${encodeURIComponent(formatDate(start))}` +
      `&EndDate=${encodeURIComponent(formatDate(end))}`;

    diag.url = url;

    // Clear request/response lists (only capture after navigation to report)
    allRequests.length = 0;
    allResponses.length = 0;
    consoleLogs.length  = 0;

    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load" });
    diag.loadMs = Date.now() - t0;

    // ── Capture initial page state ────────────────────────────────────────
    diag.initialState = await page.evaluate(() => {
      const win = window as any;
      return {
        hasDoPostBack:  typeof win.__doPostBack === "function",
        hasSM:          typeof win.Sys?.WebForms?.PageRequestManager !== "undefined",
        rvFound:        !!win.$find?.("ReportViewer1"),
        rvClientState:  win.$find?.("ReportViewer1")?._clientState ?? null,
        parametersRow:  document.getElementById("ParametersRowReportViewer1")?.style.display ?? "not found",
        asyncWait:      document.getElementById("AsyncWaitReportViewer1") ? "found" : "not found",
        pageTitle:      document.title,
        bodySnippet:    document.body?.innerHTML?.substring(0, 2000) ?? "",
      };
    });

    // Extract ControlID from the allRequests captured during page.goto()
    // (SessionKeepAlive fires at ~745ms during page load, before goto() resolves)
    let controlId: string | null = null;
    for (const req of allRequests) {
      const m = req.url.match(/[?&]ControlID=([a-f0-9]+)/i);
      if (m) { controlId = m[1]; break; }
    }
    // If not yet fired, wait up to 5s more
    if (!controlId) {
      const ctrlListener = (r: HTTPResponse) => {
        const m = r.url().match(/[?&]ControlID=([a-f0-9]+)/i);
        if (m) controlId = m[1];
      };
      page.on("response", ctrlListener);
      await sleep(5_000);
      page.off("response", ctrlListener);
    }
    diag.controlId = controlId;

    // ── Early frame check: what iframes exist after page load? ───────────
    diag.framesAfterLoad = page.frames().map(f => ({ url: f.url(), name: f.name() }));

    // Wait a bit more for SSRS JS to trigger any iframe navigations
    await sleep(5_000);
    diag.framesAfter5s = page.frames().map(f => ({ url: f.url(), name: f.name() }));

    // ── Helper: fire UpdatePanel POST and return section list ─────────────
    async function testPostback(target: string): Promise<string> {
      return page.evaluate(async (t: string): Promise<string> => {
        const doPost = async (target: string) => {
          const form = document.querySelector<HTMLFormElement>("#form1, form");
          if (!form) return "ERR:no-form";
          const params = new URLSearchParams();
          form.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach(el => {
            if (el.name && el.type !== "submit" && el.type !== "image" && el.type !== "button")
              params.append(el.name, el.value ?? "");
          });
          params.set("__EVENTTARGET", target);
          params.set("__EVENTARGUMENT", "");
          const sm = (window as any).Sys?.WebForms?.PageRequestManager?.getInstance?.();
          const smId: string = sm?._scriptManagerID ?? "ScriptManager1";
          params.set(smId, `${smId}|${target}`);
          const resp = await fetch(form.action, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", "X-MicrosoftAjax": "Delta=true", "X-Requested-With": "XMLHttpRequest" },
            body: params.toString(),
          });
          const text = await resp.text();
          const sections: string[] = [];
          let pos = 0;
          while (pos < text.length && sections.length < 25) {
            const p1 = text.indexOf("|", pos); if (p1 < 0) break;
            const len = parseInt(text.substring(pos, p1), 10); if (isNaN(len)) break;
            const p2 = text.indexOf("|", p1 + 1); if (p2 < 0) break;
            const type = text.substring(p1 + 1, p2);
            const p3 = text.indexOf("|", p2 + 1); if (p3 < 0) break;
            const contentStart = p3 + 1;
            if (contentStart + len > text.length) break;
            const content = text.substring(contentStart, contentStart + len);
            sections.push(`${type}(${len})`);
            if (type === "updatePanel") sections.push(`PANEL_HTML:${content.substring(0, 300)}`);
            if (type === "panelsToRefreshIDs" || type === "updatePanelIDs" || type === "postBackControlIDs") sections.push(`CONTENT:${content}`);
            if (type === "error") sections.push(`ERROR:${content}`);
            pos = contentStart + len + 1;
          }
          return `STATUS:${resp.status} LEN:${text.length} SECTS:${JSON.stringify(sections)}`;
        };
        return doPost(t);
      }, target).catch((e: any) => `ERR:${(e as Error).message}`);
    }

    // ── Helper: OpType=Export CSV ─────────────────────────────────────────
    async function testExport(ctrl: string): Promise<string> {
      return page.evaluate(async (c: string, v: string): Promise<string> => {
        try {
          const exportUrl = `/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=Export&Version=${encodeURIComponent(v)}&ControlID=${c}&Culture=en-US&UICulture=en-US&ReportStack=1&ExportFormat=CSV`;
          const resp = await fetch(exportUrl, { credentials: "include" });
          const text = await resp.text();
          if (resp.status === 200) {
            return `STATUS:200 REDIRECTED:${resp.redirected} LEN:${text.length} CSV_SNIPPET:${text.substring(0, 1000)}`;
          }
          // Extract ASP.NET error details
          const descMatch = text.match(/<b>Description:<\/b>\s*(.*?)<\/p>/s);
          const exMatch   = text.match(/<b>Exception Details:<\/b>\s*(.*?)<\/p>/s);
          const msgMatch  = text.match(/<title>(.*?)<\/title>/);
          const errMsg    = descMatch ? descMatch[1].replace(/<[^>]+>/g, "").trim() : "";
          const exDetail  = exMatch   ? exMatch[1].replace(/<[^>]+>/g, "").trim().substring(0, 400) : "";
          const title     = msgMatch  ? msgMatch[1] : "";
          return `STATUS:${resp.status} REDIRECTED:${resp.redirected} LEN:${text.length} TITLE:${title} DESC:${errMsg} EX:${exDetail}`;
        } catch (e: any) { return `ERR:${e?.message}`; }
      }, ctrl, SSRS_VERSION).catch(() => "ERR:evaluate-threw");
    }

    // Get all form field names (SSRS-specific fields beyond standard ASP.NET)
    diag.formFields = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLInputElement>("#form1 input, #form1 select, #form1 textarea, form input, form select"))
        .filter(el => el.name && el.type !== "submit" && el.type !== "image")
        .map(el => `${el.name}=${el.value?.substring(0, 30) ?? ""}`)
    ).catch(() => []);

    // Helper: postback with overrideable EVENTTARGET + EVENTARGUMENT + optional field overrides
    async function testPostbackExt(target: string, argument: string, overrides: Record<string, string> = {}): Promise<string> {
      return page.evaluate(async (t: string, arg: string, ov: Record<string, string>): Promise<string> => {
        const form = document.querySelector<HTMLFormElement>("#form1, form");
        if (!form) return "ERR:no-form";
        const params = new URLSearchParams();
        form.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach(el => {
          if (el.name && el.type !== "submit" && el.type !== "image" && el.type !== "button")
            params.append(el.name, el.value ?? "");
        });
        params.set("__EVENTTARGET", t);
        params.set("__EVENTARGUMENT", arg);
        for (const [k, v] of Object.entries(ov)) params.set(k, v);
        const sm = (window as any).Sys?.WebForms?.PageRequestManager?.getInstance?.();
        const smId: string = sm?._scriptManagerID ?? "ScriptManager1";
        params.set(smId, `${smId}|${t}`);
        const resp = await fetch(form.action, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", "X-MicrosoftAjax": "Delta=true", "X-Requested-With": "XMLHttpRequest" },
          body: params.toString(),
        });
        const text = await resp.text();
        const sections: string[] = [];
        let pos = 0;
        while (pos < text.length && sections.length < 25) {
          const p1 = text.indexOf("|", pos); if (p1 < 0) break;
          const len = parseInt(text.substring(pos, p1), 10); if (isNaN(len)) break;
          const p2 = text.indexOf("|", p1 + 1); if (p2 < 0) break;
          const type = text.substring(p1 + 1, p2);
          const p3 = text.indexOf("|", p2 + 1); if (p3 < 0) break;
          const contentStart = p3 + 1;
          if (contentStart + len > text.length) break;
          const content = text.substring(contentStart, contentStart + len);
          sections.push(`${type}(${len})`);
          if (type === "updatePanel") sections.push(`PANEL_HTML[${len}]:${content.substring(0, 500)}`);
          if (["panelsToRefreshIDs","updatePanelIDs","postBackControlIDs","error"].includes(type)) sections.push(`=${content}`);
          pos = contentStart + len + 1;
        }
        return `STATUS:${resp.status} LEN:${text.length} SECTS:${JSON.stringify(sections)}`;
      }, target, argument, overrides).catch((e: any) => `ERR:${(e as Error).message}`);
    }

    // ── Node.js-side SSRS requests (bypasses browser detection) ─────────────
    if (controlId) {
      try {
        const sessionCookies = await page.cookies();
        const cookieStr = sessionCookies.map(c => `${c.name}=${c.value}`).join("; ");
        diag.nodeFetch_cookies = sessionCookies.map(c => c.name); // Just names for safety

        // Extract ControlID from page HTML/JS directly (may differ from SessionKeepAlive URL)
        const pageControlId = await page.evaluate(() => {
          // Try SSRS JS object
          const rv = (window as any)?.$find?.("ReportViewer1");
          if (rv) {
            return rv._controlId ?? rv.get_controlId?.() ?? null;
          }
          // Try inline script search
          const scripts = Array.from(document.querySelectorAll("script")).map(s => s.textContent ?? "");
          for (const s of scripts) {
            const m = s.match(/"controlId"\s*:\s*"([^"]+)"/i) ?? s.match(/controlId['"]\s*[:=]\s*['"]([^'"]+)['"]/i);
            if (m) return m[1];
          }
          // Try hidden field
          const stateField = document.querySelector<HTMLInputElement>('[name*="ClientState"]');
          return stateField ? stateField.value.substring(0, 100) : null;
        }).catch(() => null);
        diag.pageControlId = pageControlId;

        // 1. Test SessionKeepAlive from Node.js (verify ControlID is valid)
        const keepAliveUrl = `https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=SessionKeepAlive&ControlID=${controlId}`;
        const kaResp = await fetch(keepAliveUrl, {
          redirect: "manual",
          headers: { "Cookie": cookieStr, "User-Agent": CHROME_UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": diag.url as string },
        });
        diag.nodeFetch_SessionKeepAlive = { status: kaResp.status, location: kaResp.headers.get("location") ?? "" };

        // 2. Test ReportPage (minimal params)
        const rpMinUrl = `https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=ReportPage&ControlID=${controlId}`;
        const rpMinResp = await fetch(rpMinUrl, {
          redirect: "manual",
          headers: { "Cookie": cookieStr, "User-Agent": CHROME_UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", "Referer": diag.url as string, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" },
        });
        const rpMinBody = rpMinResp.status === 200 ? (await rpMinResp.text()).substring(0, 500) : "";
        diag.nodeFetch_ReportPage_minimal = { status: rpMinResp.status, location: rpMinResp.headers.get("location") ?? "", bodySnippet: rpMinBody };

        // 3. Test ReportPage (full params)
        const reportPageUrl = `https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=ReportPage&Version=${encodeURIComponent(SSRS_VERSION)}&ControlID=${controlId}&Culture=en-US&UICulture=en-US&ReportStack=1`;
        const rpResp = await fetch(reportPageUrl, {
          redirect: "manual",
          headers: { "Cookie": cookieStr, "User-Agent": CHROME_UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", "Referer": diag.url as string, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
        });
        const rpLocation = rpResp.headers.get("location") ?? "";
        const rpBody = rpResp.status === 200 ? (await rpResp.text()).substring(0, 800) : "";
        diag.nodeFetch_ReportPage = { status: rpResp.status, location: rpLocation, bodySnippet: rpBody };

        // 4. Test Export directly from Node.js (after SessionKeepAlive)
        const exportUrl = `https://www.columbusdata.net/cdswebtool/Reserved.ReportViewerWebControl.axd?OpType=Export&Version=${encodeURIComponent(SSRS_VERSION)}&ControlID=${controlId}&Culture=en-US&UICulture=en-US&ReportStack=1&ExportFormat=CSV`;
        const exResp = await fetch(exportUrl, { headers: { "Cookie": cookieStr, "User-Agent": CHROME_UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": diag.url as string } });
        const exText = await exResp.text();
        diag.nodeFetch_Export = { status: exResp.status, len: exText.length, csvSnippet: exText.substring(0, 400) };

        // 5. Full URL of allRequests SessionKeepAlive (to see the FULL ControlID)
        const skReq = allRequests.find(r => r.url.includes("SessionKeepAlive"));
        diag.sessionKeepAliveFullUrl = skReq?.url ?? null;

      } catch (e: any) {
        diag.nodeFetch_Error = String(e?.message ?? e);
      }
    }

    // ── Test report.aspx (the CORRECT portal URL format for SSRS reports) ──
    // Portal uses /includes/report.aspx?rptname=xxx, NOT /includes/ReportViewer.aspx
    const reportAspxUrl =
      `https://www.columbusdata.net/cdswebtool/includes/report.aspx?rptname=${REPORT_NAME}` +
      `&TermID=${encodeURIComponent(termId)}` +
      `&StartDate=${encodeURIComponent(formatDate(start))}` +
      `&EndDate=${encodeURIComponent(formatDate(end))}`;
    // start/end already declared above (they're in same scope)
    diag.reportAspxUrl = reportAspxUrl;
    await page.goto(reportAspxUrl, { waitUntil: "load" });
    await sleep(3_000);
    diag.reportAspx = {
      url: page.url(),
      title: await page.title(),
      bodySnippet: (await page.content()).substring(0, 3000),
      domTables: await page.evaluate(() =>
        Array.from(document.querySelectorAll("table")).map(t => ({
          id: t.id, rows: t.rows.length, text: (t.textContent ?? "").substring(0, 300),
        }))
      ).catch(() => []),
      frames: page.frames().map(f => ({ url: f.url(), name: f.name() })),
    };

    // ── Test journal.aspx (Real-time Transactions → Online Journals) ──────
    // Non-SSRS page. Terminal uses a Telerik RadComboBox that needs JS API to select.
    const journalBase = `https://www.columbusdata.net/cdswebtool/TerminalMonitoring/journal.aspx`;
    const journalUrl = `${journalBase}?TermID=${encodeURIComponent(termId)}&StartDate=${encodeURIComponent(formatDate(start))}&EndDate=${encodeURIComponent(formatDate(end))}`;
    diag.journalUrl = journalUrl;
    await page.goto(journalUrl, { waitUntil: "load" });

    // Wait for Telerik JS to initialize (up to 5 s)
    for (let i = 0; i < 10; i++) {
      const ready = await page.evaluate(() => typeof (window as any).$find === "function").catch(() => false);
      if (ready) break;
      await sleep(500);
    }
    await sleep(500);

    // Inspect form fields BEFORE submission
    diag.journalFormFields = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input, select, textarea"))
        .filter((el: Element) => !!(el as HTMLInputElement).name)
        .map((el: Element) => {
          const e = el as HTMLInputElement;
          return `${e.tagName}[type=${e.type}][name=${e.name}][id=${e.id}] value=${(e.value||"").substring(0,40)}`;
        })
    ).catch(() => []);

    // Capture lnkView outerHTML + form dates info before manipulating
    diag.journalPreInfo = await page.evaluate(() => {
      const lnk = document.getElementById("lnkView");
      const beginInput = document.getElementById("txtBeginDateTime1") as HTMLInputElement;
      const endInput = document.getElementById("txtEndingDateTime1") as HTMLInputElement;
      return {
        lnkViewHtml: lnk?.outerHTML ?? "not found",
        beginDate: beginInput?.value ?? "n/a",
        endDate: endInput?.value ?? "n/a",
        doPostBackExists: typeof (window as any).__doPostBack === "function",
      };
    }).catch((e: Error) => ({ error: String(e) }));

    // Step 1: Type terminal ID to trigger Telerik keyup → AJAX LoadOnDemand
    const comboInput = await page.$("#cbsTerminals_radTerminalSelector_Input");
    if (comboInput) {
      await page.click("#cbsTerminals_radTerminalSelector_Input");
      await page.evaluate(() => {
        const el = document.getElementById("cbsTerminals_radTerminalSelector_Input") as HTMLInputElement;
        if (el) { el.value = ""; el.select(); }
      });
      await page.type("#cbsTerminals_radTerminalSelector_Input", termId, { delay: 80 });
    }

    // Wait for Telerik dropdown DOM items to appear (.rcbItem) — up to 5s
    await page.waitForSelector(".rcbItem", { timeout: 5_000 }).catch(() => null);
    await sleep(500);

    // Check DOM for visible dropdown items (before Telerik JS model)
    diag.journalDomItems = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".rcbItem, [class*='rcbItem']"))
        .map(el => ({ text: el.textContent?.trim() ?? "", id: el.id }))
        .slice(0, 10)
    ).catch(() => []);

    // Check Telerik JS model items count
    diag.journalDropdownItems = await page.evaluate(() => {
      const w = window as any;
      const combo = w.$find?.("cbsTerminals_radTerminalSelector");
      if (!combo) return { error: "combo not found" };
      const items = combo.get_items();
      const result: Array<{text: string; value: string; index: number}> = [];
      for (let i = 0; i < Math.min(items.get_count(), 10); i++) {
        const item = items.getItem(i);
        result.push({ text: item.get_text(), value: item.get_value(), index: i });
      }
      return { count: items.get_count(), first10: result };
    }).catch((e: Error) => ({ error: String(e) }));

    // Try clicking matching DOM item first (if dropdown is open)
    diag.journalDomClick = await page.evaluate((targetId: string) => {
      const items = Array.from(document.querySelectorAll(".rcbItem, [class*='rcbItem']"));
      const match = items.find(el => el.textContent?.includes(targetId));
      if (match) {
        (match as HTMLElement).click();
        return `clicked DOM .rcbItem: ${match.textContent?.trim()}`;
      }
      return "no .rcbItem matched";
    }, termId).catch((e: Error) => String(e));

    // If DOM click didn't select an item, use Telerik JS API or craft ClientState
    diag.journalSelectResult = await page.evaluate((targetId: string) => {
      const w = window as any;
      const combo = w.$find?.("cbsTerminals_radTerminalSelector");
      if (!combo) return "combo not found";
      const items = combo.get_items();
      for (let i = 0; i < items.get_count(); i++) {
        const item = items.getItem(i);
        if (item.get_value() === targetId || item.get_text().includes(targetId)) {
          item.select();
          return `JS-selected[${i}]: value=${item.get_value()} text=${item.get_text()}`;
        }
      }
      // Last resort: craft ClientState directly
      const input = document.getElementById("cbsTerminals_radTerminalSelector_Input") as HTMLInputElement;
      const stateInput = document.getElementById("cbsTerminals_radTerminalSelector_ClientState") as HTMLInputElement;
      if (input && stateInput) {
        input.value = targetId;
        stateInput.value = JSON.stringify({
          logEntries: [{ type: 5, index: 0, value: targetId, text: targetId }],
          selectedIndices: [0],
        });
        return `crafted ClientState for ${targetId}`;
      }
      return "no fallback available";
    }, termId).catch((e: Error) => String(e));

    // Step 2: Fix date range — use Telerik RadDatePicker JS API to set properly
    // (just setting text inputs doesn't update the hidden ClientState; the server
    //  reads from ClientState for validation, hence "dates required" error)
    diag.journalDateSet = await page.evaluate((sMs: number, eMs: number) => {
      const w = window as any;
      const results: string[] = [];

      const sDate = new Date(sMs);
      const eDate = new Date(eMs);
      // Make end date 11:59 PM
      eDate.setHours(23, 59, 0, 0);
      // Make start date 12:00 AM
      sDate.setHours(0, 0, 0, 0);

      // Try Telerik RadDatePicker JS API
      const beginPicker = w.$find?.("txtBeginDateTime1");
      if (beginPicker) { beginPicker.set_selectedDate(sDate); results.push("beginPicker.set_selectedDate"); }
      const endPicker = w.$find?.("txtEndingDateTime1");
      if (endPicker)   { endPicker.set_selectedDate(eDate);   results.push("endPicker.set_selectedDate"); }

      // Also update raw inputs as belt-and-suspenders
      const pad = (n: number) => String(n).padStart(2, "0");
      const toFmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-00`;
      const toDisp = (d: Date) => `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()} ${d.getHours() === 0 ? "12:00 AM" : "11:59 PM"}`;
      const s = (id: string) => document.getElementById(id) as HTMLInputElement;
      if (s("txtBeginDateTime1"))             s("txtBeginDateTime1").value = toFmt(sDate);
      if (s("txtBeginDateTime1_dateInput"))   s("txtBeginDateTime1_dateInput").value = toDisp(sDate);
      if (s("txtEndingDateTime1"))             s("txtEndingDateTime1").value = toFmt(eDate);
      if (s("txtEndingDateTime1_dateInput"))   s("txtEndingDateTime1_dateInput").value = toDisp(eDate);

      return results.length ? results.join(", ") : "only raw inputs set (no Telerik pickers)";
    }, start.getTime(), end.getTime()).catch((e: Error) => String(e));

    // Step 3: Submit — set __EVENTTARGET=lnkView then submit form
    // (avoids calling __doPostBack directly which throws in strict-mode evaluate context)
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(() => null),
        page.evaluate(() => {
          const t = document.getElementById("__EVENTTARGET") as HTMLInputElement;
          const a = document.getElementById("__EVENTARGUMENT") as HTMLInputElement;
          if (t) t.value = "lnkView";
          if (a) a.value = "";
          (document.getElementById("Form1") as HTMLFormElement)?.submit();
        }),
      ]);
      diag.journalSubmitMethod = "EVENTTARGET=lnkView + form.submit()";
    } catch (e) {
      diag.journalSubmitError = String(e);
    }

    await sleep(1_000);

    diag.journal = {
      url: page.url(),
      title: await page.title().catch(() => "(detached)"),
      bodySnippet: (await page.content().catch(() => "")).substring(0, 5000),
      domTables: await page.evaluate(() =>
        Array.from(document.querySelectorAll("table")).map(t => ({
          id: t.id, rows: t.rows.length, text: (t.textContent ?? "").substring(0, 800),
        }))
      ).catch(() => []),
    };

    // ── Test TerminalActivitySummary (Quick View) ─────────────────────────
    const actUrl = `https://www.columbusdata.net/cdswebtool/QuickView/TerminalActivitySummary.aspx?TermID=${encodeURIComponent(termId)}&StartDate=${encodeURIComponent(formatDate(start))}&EndDate=${encodeURIComponent(formatDate(end))}`;
    diag.actUrl = actUrl;
    await page.goto(actUrl, { waitUntil: "load" });
    await sleep(2_000);
    diag.actSummary = {
      url: page.url(),
      title: await page.title(),
      bodySnippet: (await page.content()).substring(0, 3000),
      domTables: await page.evaluate(() =>
        Array.from(document.querySelectorAll("table")).map(t => ({
          id: t.id, rows: t.rows.length, text: (t.textContent ?? "").substring(0, 400),
        }))
      ).catch(() => []),
    };

    // Re-navigate back to report URL for remaining SSRS tests
    await page.goto(diag.url as string, { waitUntil: "load" });
    await sleep(2_000);

    // Test A: $ctl09$ReportControl$ctl00 with Navigate1 (report control postback — what SSRS JS actually calls)
    diag.postResult_reportCtl_Navigate1 = await testPostbackExt("ReportViewer1$ctl09$ReportControl$ctl00", "Navigate1");

    // Test B: same but with browser mode = "full" (fix quirks mode detection)
    diag.postResult_reportCtl_Navigate1_full = await testPostbackExt(
      "ReportViewer1$ctl09$ReportControl$ctl00", "Navigate1",
      { "ReportViewer1$ctl11": "full" }
    );

    // Test C: $ctl03 with browser mode = "full"
    diag.postResult_ctl03_full = await testPostbackExt("ReportViewer1$ctl03", "", { "ReportViewer1$ctl11": "full" });

    // Export after postbacks (no wait)
    if (controlId) {
      diag.exportResult_immediate = await testExport(controlId);
    }

    // Wait 5s then export again
    await sleep(5_000);
    if (controlId) {
      diag.exportResult_after5s = await testExport(controlId);
    }

    diag.pageUrl   = page.url();
    diag.pageTitle = await page.title();
    diag.finalHtmlSnippet = (await page.content()).substring(0, 3000);

    // ── Frame inspection: check for cross-origin frames (e.g. cdsatm.com) ──
    const frames = page.frames();
    diag.frames = frames.map(f => ({ url: f.url(), name: f.name() }));
    // Try to read HTML from any non-main frame (cross-origin frames may throw)
    const frameDetails: Record<string, unknown>[] = [];
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const fUrl  = frame.url();
        const fHtml = await frame.content().catch(() => "");
        const fTables = await frame.evaluate(() =>
          Array.from(document.querySelectorAll("table")).map(t => ({
            id: t.id, rows: t.rows.length, text: (t.textContent ?? "").substring(0, 300),
          }))
        ).catch(() => []);
        frameDetails.push({ url: fUrl, htmlLen: fHtml.length, htmlSnippet: fHtml.substring(0, 1000), tables: fTables });
      } catch (e: any) {
        frameDetails.push({ url: frame.url(), error: e?.message });
      }
    }
    diag.frameDetails = frameDetails;

    diag.allRequests  = allRequests.map(r => ({ ...r, t: r.t - t0 }));
    diag.allResponses = allResponses.map(r => ({ ...r, t: r.t - t0 }));
    diag.consoleLogs  = consoleLogs;
    diag.pageErrors   = pageErrors;

    // DOM table summary
    diag.domTables = await page.evaluate(() =>
      Array.from(document.querySelectorAll("table")).map(t => ({
        id: t.id,
        rows: t.rows.length,
        snippet: (t.textContent ?? "").substring(0, 200),
      }))
    );

  } finally {
    await browser?.close().catch(() => {});
  }

  return diag;
}
