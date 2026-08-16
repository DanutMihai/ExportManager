/**
 * BuildRequestSheets — chunked writer for the SIM request handover workbook.
 *
 * Called once per chunk from `Do until write chunks` (03_Export_Flow_Spec.md §11.5).
 * The Power Automate action's retry policy MUST be None: a retry after a partial write
 * duplicates rows.
 *
 * Four design notes worth reading before changing anything:
 *
 * 1. THE SCRIPT HAS NO MEMORY BETWEEN CHUNKS. Each invocation is a cold start, so
 *    nothing may be accumulated in a module variable. Row position comes from
 *    table.addRows() appending; cumulative counts are read back from the tables
 *    themselves, which is the only number that cannot drift.
 *
 * 2. COLUMNS ARE MATCHED BY HEADER NAME, NOT POSITION. Each table's header row is read
 *    from the template and normalised (lowercase, alphanumerics only), then looked up
 *    in the request object: "Current ICCID" -> "currenticcid" -> payload key
 *    "currentIccid". Add a column to the template and it fills itself if a matching key
 *    exists, or comes back in `unfilledHeaders` if not. This removes the class of bug
 *    where the script's column list drifts from the template (01_Edge_Cases.md §7).
 *
 * 3. FORMATTING, VALIDATION AND CELL LOCKING LIVE IN THE TEMPLATE, NOT HERE. The script
 *    only calls protect() on the final chunk. See 06_Handover_Template_Spec.md.
 *
 * 4. Unmapped and incomplete requests are NOT written to the workbook — they come back
 *    in `skipped` for the admin. A provider must never see a half-formed request, and a
 *    tab named "Needs attention" inside the file they receive is exactly that.
 */

interface TypeMapEntry {
  type: string;
  sheet: string;
  table: string;
  required: string[];
}

interface Payload {
  runId: string;
  country: string;
  exportedUtc: string;
  startRowIndex: number;
  totalExpectedRows: number;
  finalize: boolean;
  textHeaders: string[];
  requests: RequestRow[];
  typeMap: TypeMapEntry[];
}

type Cell = string | number | boolean | null;
interface RequestRow { [key: string]: Cell }
interface SkipEntry { id: string; reason: string }
interface BreakdownEntry { sheet: string; rows: number }

const META_SHEET = "_Meta";
const INSTRUCTIONS_SHEET = "Instructions";

function main(workbook: ExcelScript.Workbook, payloadJson: string): string {
  const p: Payload = JSON.parse(payloadJson) as Payload;

  if (!p.typeMap || p.typeMap.length === 0) {
    throw new Error("Payload carries no typeMap — nothing could be routed.");
  }

  // Run the template guards once, before a single row is written. Everything they
  // check is a silent corruption if it slips through: the file looks perfectly normal
  // and the damage surfaces weeks later, at the provider.
  if (p.startRowIndex === 0) {
    assertTemplate(workbook, p);
  }

  // ------------------------------------------------------------- route rows
  const typeByNorm = new Map<string, TypeMapEntry>();
  for (const entry of p.typeMap) {
    typeByNorm.set(norm(entry.type), entry);
  }

  const skipped: SkipEntry[] = [];
  const buckets = new Map<string, RequestRow[]>();

  for (const request of p.requests) {
    const row: RequestRow = normaliseKeys(request);
    const id: string = asText(row["requestid"]);
    const rawType: string = asText(row["requesttype"]);

    const entry: TypeMapEntry = typeByNorm.get(norm(rawType));
    if (!entry) {
      // Never dropped silently — 01_Edge_Cases.md §3.
      skipped.push({ id: id, reason: "unmapped:" + (rawType === "" ? "(blank)" : rawType) });
      continue;
    }

    const missing: string[] = [];
    for (const key of entry.required) {
      if (asText(row[norm(key)]) === "") {
        missing.push(key);
      }
    }
    if (missing.length > 0) {
      // A request the provider would bounce back a week later — 01_Edge_Cases.md §4.
      skipped.push({ id: id, reason: "missing:" + missing.join(",") });
      continue;
    }

    if (!buckets.has(entry.table)) {
      buckets.set(entry.table, []);
    }
    buckets.get(entry.table).push(row);
  }

  // ------------------------------------------------------------ write chunk
  const unfilled = new Map<string, boolean>();
  let rowsWritten: number = 0;

  buckets.forEach((rows: RequestRow[], tableName: string) => {
    const table: ExcelScript.Table = workbook.getTable(tableName);
    if (!table) {
      throw new Error("Template is missing table '" + tableName + "'.");
    }

    const headers: string[] = table
      .getHeaderRowRange()
      .getValues()[0]
      .map((h) => String(h));
    const keys: string[] = headers.map((h) => norm(h));

    const values: (string | number | boolean)[][] = [];
    for (const row of rows) {
      const line: (string | number | boolean)[] = [];
      for (let i = 0; i < keys.length; i++) {
        const value: Cell = row[keys[i]];
        if (value === undefined || value === null || value === "") {
          // Either a provider fill-in column, or template drift. Reported either way.
          unfilled.set(headers[i], true);
          line.push("");
        } else if (typeof value === "boolean") {
          line.push(value ? "Yes" : "No");
        } else {
          // Always written as a string. Combined with the template's "@" number format
          // this is what keeps a 20-digit ICCID intact: Excel carries only 15
          // significant digits, so a numeric ICCID loses its tail before anyone sees it.
          line.push(String(value));
        }
      }
      values.push(line);
    }

    if (values.length > 0) {
      table.addRows(null, values);
      rowsWritten += values.length;
    }
  });

  // --------------------------------------------------------------- finalize
  const breakdown: BreakdownEntry[] = [];
  let cumulativeRows: number = 0;

  for (const entry of p.typeMap) {
    const table: ExcelScript.Table = workbook.getTable(entry.table);
    if (!table) {
      continue;
    }
    const count: number = table.getRowCount();

    if (p.finalize && count === 0) {
      // A provider opening five tabs where two have data assumes the empty ones are a
      // mistake, and emails to ask — 01_Edge_Cases.md §2.
      const sheet: ExcelScript.Worksheet = workbook.getWorksheet(entry.sheet);
      if (sheet) {
        sheet.delete();
      }
      continue;
    }

    if (count > 0) {
      breakdown.push({ sheet: entry.sheet, rows: count });
      cumulativeRows += count;
    }
  }

  if (p.finalize) {
    writeMeta(workbook, p, cumulativeRows);
    protectSheets(workbook, p);
  }

  // ----------------------------------------------------------------- result
  const breakdownText: string = breakdown
    .map((b) => b.sheet + ": " + b.rows)
    .join(" · ");

  const unfilledHeaders: string[] = [];
  unfilled.forEach((_present, header) => unfilledHeaders.push(header));

  return JSON.stringify({
    rowsWritten: rowsWritten,
    cumulativeRows: cumulativeRows,
    breakdown: breakdown,
    breakdownText: breakdownText === "" ? "No rows written" : breakdownText,
    skippedIds: skipped.map((s) => s.id),
    skipped: skipped,
    unfilledHeaders: unfilledHeaders,
    finalized: p.finalize
  });
}

/* ------------------------------------------------------------------ helpers */

/**
 * Lowercase, alphanumerics only. Applied to BOTH template headers and payload keys, so
 * "Current ICCID", "current_iccid" and "currentIccid" all collapse to "currenticcid".
 */
function norm(s: string): string {
  if (s === null || s === undefined) {
    return "";
  }
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normaliseKeys(row: RequestRow): RequestRow {
  const out: RequestRow = {};
  for (const key of Object.keys(row)) {
    out[norm(key)] = row[key];
  }
  return out;
}

function asText(v: Cell): string {
  if (v === null || v === undefined) {
    return "";
  }
  return String(v).trim();
}

/**
 * Fail before writing, not after.
 *
 * The number-format check is the important one. It reads the cell directly below each
 * header — the cell the first added row will land in — so it works on a table that
 * ships with zero data rows, which is how the handover template is built.
 */
function assertTemplate(workbook: ExcelScript.Workbook, p: Payload): void {
  const problems: string[] = [];

  for (const entry of p.typeMap) {
    const table: ExcelScript.Table = workbook.getTable(entry.table);
    if (!table) {
      problems.push("missing table '" + entry.table + "' for type '" + entry.type + "'");
      continue;
    }

    if (table.getRowCount() > 0) {
      // The flow copies the template on every run, so a non-empty table means the
      // template itself was saved with rows in it — usually leftover sample data.
      problems.push(
        "table '" + entry.table + "' already holds " + table.getRowCount() +
        " row(s); the template must ship empty"
      );
      continue;
    }

    const headers: string[] = table.getHeaderRowRange().getValues()[0].map((h) => String(h));
    const tableRange: ExcelScript.Range = table.getRange();
    const sheet: ExcelScript.Worksheet = table.getWorksheet();
    const headerRowIndex: number = tableRange.getRowIndex();
    const firstColumnIndex: number = tableRange.getColumnIndex();

    for (let i = 0; i < headers.length; i++) {
      if (!isTextHeader(headers[i], p.textHeaders)) {
        continue;
      }
      const probe: ExcelScript.Range = sheet.getCell(headerRowIndex + 1, firstColumnIndex + i);
      const format: string = String(probe.getNumberFormat());
      if (format !== "@") {
        problems.push(
          "'" + entry.sheet + "'!" + headers[i] + " is formatted '" + format +
          "' — must be Text (@), or digits past the 15th are lost"
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error("Handover template is not usable: " + problems.join("; ") + ".");
  }
}

function isTextHeader(header: string, textHeaders: string[]): boolean {
  if (!textHeaders) {
    return false;
  }
  const h: string = norm(header);
  for (const candidate of textHeaders) {
    if (norm(candidate) === h) {
      return true;
    }
  }
  return false;
}

/**
 * Hidden metadata, written on the final chunk. This is what lets the return-leg import
 * tell a current file from a stale one, and confirm the file came from a real export
 * rather than being hand-assembled. It costs nothing now and is awkward to add once
 * providers are used to a format.
 *
 * veryHidden rather than hidden: it cannot be unhidden from the Excel UI, only by code.
 * That is integrity, not secrecy — nothing confidential goes here.
 */
function writeMeta(workbook: ExcelScript.Workbook, p: Payload, cumulativeRows: number): void {
  let meta: ExcelScript.Worksheet = workbook.getWorksheet(META_SHEET);
  if (!meta) {
    meta = workbook.addWorksheet(META_SHEET);
  }
  meta.setVisibility(ExcelScript.SheetVisibility.visible);
  meta.getRange("A1:B12").clear(ExcelScript.ClearApplyTo.contents);
  meta.getRange("A1:B8").setValues([
    ["Key", "Value"],
    ["RunId", p.runId],
    ["Country", p.country],
    ["ExportedUtc", p.exportedUtc],
    ["RowsWritten", String(cumulativeRows)],
    ["TotalExpectedRows", String(p.totalExpectedRows)],
    ["SchemaVersion", "1"],
    ["GeneratedBy", "BuildRequestSheets"]
  ]);
  meta.getRange("A:B").getFormat().autofitColumns();
  meta.setVisibility(ExcelScript.SheetVisibility.veryHidden);
}

/**
 * Applied last, on the final chunk only. The template ships unprotected so the script
 * can write. If a run fails mid-way the file is left unprotected — but the catch scope
 * deletes partial files, so no unprotected workbook is ever delivered.
 *
 * No password: this prevents accidents rather than determined edits, and a locked-out
 * provider is a support call you do not want. WHICH cells are unlocked is decided in
 * the template, not here.
 */
function protectSheets(workbook: ExcelScript.Workbook, p: Payload): void {
  const options: ExcelScript.WorksheetProtectionOptions = {
    allowAutoFilter: true,
    allowSort: true,
    allowFormatCells: false,
    allowFormatColumns: true,
    allowFormatRows: true,
    allowInsertRows: false,
    allowInsertColumns: false,
    allowDeleteRows: false,
    allowDeleteColumns: false
  };

  for (const entry of p.typeMap) {
    const sheet: ExcelScript.Worksheet = workbook.getWorksheet(entry.sheet);
    if (sheet) {
      sheet.getProtection().protect(options);
    }
  }

  const instructions: ExcelScript.Worksheet = workbook.getWorksheet(INSTRUCTIONS_SHEET);
  if (instructions) {
    instructions.getProtection().protect(options);
  }
}
