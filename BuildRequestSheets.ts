/**
 * BuildRequestSheets — chunked writer for the SIM request handover workbook.
 *
 * Called once per chunk from `Do until write chunks` (03_Export_Flow_Spec.md §11.5).
 * The Power Automate action's retry policy MUST be None: a retry after a partial write
 * duplicates rows.
 *
 * ---------------------------------------------------------------------------
 * v3 — WHAT CHANGED, AND WHY IT MATTERED
 * ---------------------------------------------------------------------------
 *
 *  1. IT NO LONGER WRITES THE COLUMNS IT HAS NO DATA FOR.  ← the important one
 *
 *     v2 built a value for every header in the table and wrote the full width in
 *     one addRows() call, pushing "" into every column the payload had no key for.
 *     Those columns are the check formulas (ICC_Check, Date_Check, RowErrors,
 *     HasError, …) and the provider's fill-in columns. Writing "" over a formula
 *     replaces it with a literal. Excel does not restore it.
 *
 *     One export and every validation column in the provider's workbook is dead:
 *     nothing turns red, nothing errors, RowErrors is blank on every row, and the
 *     file looks perfectly fine. It would have survived testing.
 *
 *     Same fix as CopyRowsIntoTable_fixed.ts on the import side: work out which
 *     headers the payload actually names, write those in contiguous runs, and step
 *     over everything else.
 *
 *  2. TABLES ARE RESIZED AND WRITTEN BY RANGE, not grown with addRows().
 *
 *     addRows() appends whole rows, which is what forced the full-width write in
 *     the first place. Resizing the table and writing per-column runs is the same
 *     shape as the import script, and it is what makes (1) and (3) possible.
 *
 *  3. FORMULA COLUMNS ARE REPAIRED AFTER EVERY WRITE.
 *
 *     table.resize() is supposed to extend a table's calculated columns to the new
 *     rows. In Excel Online it does not do so reliably — some columns propagate and
 *     others don't, producing a file where row 1 validates correctly and every row
 *     below it silently reports OK. autoFill(fillCopy) from the prototype row
 *     replicates the formula down, adjusting relative references exactly as
 *     dragging the fill handle would.
 *
 *     This is why the template must ship with EXACTLY ONE data row per table
 *     (06_Handover_Template_Spec.md §"Sheets"): autoFill needs a source, and a
 *     table with zero rows has none. assertTemplate() enforces it.
 *
 *  4. CALCULATION MODE IS MANAGED.
 *
 *     Manual for the duration of each chunk, restored to automatic on finalize.
 *     Calculation mode is stored in the file, so a workbook that ships stuck in
 *     manual shows stale check columns and no conditional formatting at all — and
 *     this one goes to an external party who cannot be told to press F9.
 *
 *  5. finalize AND startRowIndex ARE COERCED.
 *
 *     They arrive as JSON. If the flow ever builds the payload with them quoted,
 *     "false" is a non-empty string and therefore truthy, and "0" !== 0 — which
 *     would finalize every chunk and skip assertTemplate() entirely. The flow is
 *     specified to send real JSON types (03 §17); this is the second lock.
 *
 *  6. Row counts come from counting filled RequestID cells, not getRowCount().
 *
 *     A resized table contains rows that have not been written yet, so
 *     getRowCount() is not the number of requests in the sheet.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THAT HAVE NOT CHANGED, AND SHOULD NOT
 * ---------------------------------------------------------------------------
 *
 *  A. THE SCRIPT HAS NO MEMORY BETWEEN CHUNKS. Each invocation is a cold start,
 *     so nothing may be accumulated in a module variable. Everything cumulative is
 *     read back from the workbook, which is the only number that cannot drift.
 *
 *  B. COLUMNS ARE MATCHED BY HEADER NAME, NOT POSITION. Each table's header row is
 *     read from the template and normalised (lowercase, alphanumerics only), then
 *     looked up in the request object: "Current ICCID" -> "currenticcid" -> payload
 *     key "currentIccid". Add a column to the template and it fills itself if a
 *     matching key exists, or comes back in `unfilledHeaders` if not.
 *
 *  And one rule that is not negotiable: unmapped and incomplete requests are NOT
 *  written to the workbook. They come back in `skipped` for the admin. A provider
 *  must never see a half-formed request, and a tab named "Needs attention" inside
 *  the file they receive is exactly that.
 */

interface TypeMapEntry {
  type: string;
  sheet: string;
  table: string;
  required: string[];
  /** Headers to force blank on this sheet even when a payload key matches.
   *  New SIM's PhoneNr / ICCID / StartDate are the provider's to fill. */
  blankHeaders?: string[];
}

interface Payload {
  runId: string;
  country: string;
  actionedBy: string;
  exportedUtc: string;
  startRowIndex: number | string;
  totalExpectedRows: number | string;
  finalize: boolean | string;
  /** Header whose filled cells count as "a real request". Default RequestID. */
  rowKeyHeader?: string;
  textHeaders: string[];
  requests: RequestRow[];
  typeMap: TypeMapEntry[];
}

type Cell = string | number | boolean | null;
interface RequestRow { [key: string]: Cell }
interface SkipEntry { id: string; reason: string }
interface BreakdownEntry { sheet: string; rows: number }

const META_SHEET: string = "_Meta";
const INSTRUCTIONS_SHEET: string = "Instructions";
const DEFAULT_ROW_KEY: string = "RequestID";

function main(workbook: ExcelScript.Workbook, payloadJson: string): string {
  const p: Payload = JSON.parse(payloadJson) as Payload;

  if (!p.typeMap || p.typeMap.length === 0) {
    throw new Error("Payload carries no typeMap — nothing could be routed.");
  }

  // ---- coerce the two values whose type silently changes behaviour ---------
  const startRowIndex: number = toInt(p.startRowIndex);
  const totalExpectedRows: number = toInt(p.totalExpectedRows);
  const finalize: boolean = toBool(p.finalize);
  const rowKeyHeader: string = p.rowKeyHeader ? p.rowKeyHeader : DEFAULT_ROW_KEY;
  const textHeaders: string[] = p.textHeaders ? p.textHeaders : [];

  // Template guards run once, before a single cell is written. Everything they
  // check is a silent corruption if it slips through: the file looks normal and
  // the damage surfaces weeks later, at the provider.
  if (startRowIndex === 0) {
    assertTemplate(workbook, p, textHeaders, rowKeyHeader);
  }

  // Each Run script call is its own session, so this is re-asserted per chunk.
  const app: ExcelScript.Application = workbook.getApplication();
  app.setCalculationMode(ExcelScript.CalculationMode.manual);

  // ------------------------------------------------------------- route rows
  const typeByNorm: Map<string, TypeMapEntry> = new Map<string, TypeMapEntry>();
  for (const entry of p.typeMap) {
    typeByNorm.set(norm(entry.type), entry);
  }

  const skipped: SkipEntry[] = [];
  const buckets: Map<string, RequestRow[]> = new Map<string, RequestRow[]>();

  for (const request of (p.requests ? p.requests : [])) {
    const row: RequestRow = normaliseKeys(request);
    const id: string = asText(row["requestid"]);
    const rawType: string = asText(row["requesttype"]);

    const entry: TypeMapEntry | undefined = typeByNorm.get(norm(rawType));
    if (entry === undefined) {
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
      // A request the provider would bounce back a week later — 01 §4.
      skipped.push({ id: id, reason: "missing:" + missing.join(",") });
      continue;
    }

    if (!buckets.has(entry.table)) {
      buckets.set(entry.table, []);
    }
    const bucket: RequestRow[] | undefined = buckets.get(entry.table);
    if (bucket !== undefined) {
      bucket.push(row);
    }
  }

  // ------------------------------------------------------------ write chunk
  const unfilled: Map<string, boolean> = new Map<string, boolean>();
  let rowsWritten: number = 0;

  for (const entry of p.typeMap) {
    const rows: RequestRow[] | undefined = buckets.get(entry.table);
    if (rows === undefined || rows.length === 0) {
      continue;
    }
    rowsWritten += writeBucket(workbook, entry, rows, textHeaders, rowKeyHeader, unfilled);
  }

  // --------------------------------------------------------------- finalize
  const breakdown: BreakdownEntry[] = [];
  let cumulativeRows: number = 0;

  for (const entry of p.typeMap) {
    const table: ExcelScript.Table = workbook.getTable(entry.table);
    if (!table) {
      continue;
    }
    const filled: number = countFilled(table, rowKeyHeader);

    if (finalize && filled === 0) {
      // A provider opening five tabs where two have data assumes the empty ones
      // are a mistake, and emails to ask — 01_Edge_Cases.md §2.
      const sheet: ExcelScript.Worksheet = workbook.getWorksheet(entry.sheet);
      if (sheet) {
        sheet.delete();
      }
      continue;
    }

    if (filled > 0) {
      breakdown.push({ sheet: entry.sheet, rows: filled });
      cumulativeRows += filled;
    }
  }

  if (finalize) {
    writeMeta(workbook, p, cumulativeRows, totalExpectedRows);
    protectWorkbook(workbook, p);
    app.setCalculationMode(ExcelScript.CalculationMode.automatic);
    app.calculate(ExcelScript.CalculationType.fullRebuild);
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
    finalized: finalize
  });
}

/* ==========================================================================
   writing
   ========================================================================== */

/**
 * Write one type's rows into its table.
 *
 * Position is derived from the workbook, not from startRowIndex: the flow's
 * offset counts requests across ALL types, while each table only holds its own.
 * Counting filled RequestID cells is the only figure that survives a cold start.
 */
function writeBucket(
  workbook: ExcelScript.Workbook,
  entry: TypeMapEntry,
  rows: RequestRow[],
  textHeaders: string[],
  rowKeyHeader: string,
  unfilled: Map<string, boolean>
): number {
  const table: ExcelScript.Table = workbook.getTable(entry.table);
  if (!table) {
    throw new Error("Template is missing table '" + entry.table + "'.");
  }

  const headers: string[] = headersOf(table);
  const keys: string[] = headers.map((h) => norm(h));
  const blocked: string[] = (entry.blankHeaders ? entry.blankHeaders : []).map((h) => norm(h));

  // Which headers does this payload actually carry a value for? The Select in
  // 03 §11.4 emits the same key set on every row, so this is stable across
  // chunks — which matters, because the classification below must be identical
  // on chunk 1 and chunk 20 or the same column would be written on one pass and
  // autoFilled on the next.
  const present: Map<string, boolean> = payloadKeySet(rows);

  const sheet: ExcelScript.Worksheet = table.getWorksheet();
  const tableRange: ExcelScript.Range = table.getRange();
  const headerRowIndex: number = tableRange.getRowIndex();
  const firstColumnIndex: number = tableRange.getColumnIndex();

  // One read, before anything is written: what does the prototype row hold in
  // each column? A cell with a formula is a check column. A cell that is empty
  // is a provider fill-in column. Reading it once here is what lets the two be
  // told apart without a hard-coded list that would drift from the template.
  const prototypeFormulas: string[] = sheet
    .getRangeByIndexes(headerRowIndex + 1, firstColumnIndex, 1, headers.length)
    .getFormulas()[0]
    .map((f) => String(f));

  const writableIdx: number[] = [];
  const formulaIdx: number[] = [];
  for (let i = 0; i < headers.length; i++) {
    const isBlocked: boolean = blocked.indexOf(keys[i]) >= 0;
    if (!isBlocked && present.get(keys[i]) === true) {
      writableIdx.push(i);
      continue;
    }
    if (prototypeFormulas[i] !== "") {
      formulaIdx.push(i);                      // a check column — repaired, never written
    } else {
      unfilled.set(headers[i], true);          // left blank: the provider's, or drift
    }
  }

  if (writableIdx.length === 0) {
    throw new Error(
      "No payload key matched a header on '" + entry.sheet + "'. Headers: " +
      headers.join(", ") + ". This is template drift, not a data problem."
    );
  }

  const existing: number = countFilled(table, rowKeyHeader);
  const needed: number = existing + rows.length;
  resizeTable(table, needed);

  const firstDataRow: number = headerRowIndex + 1 + existing;

  // Text format BEFORE the values land, never after. The template sets it on the
  // whole worksheet column and resize() inherits it, so this is the second lock —
  // but it has to be the second lock in the right order, because a 20-digit ICCID
  // that has already been parsed as a number has already lost its tail.
  applyTextFormat(sheet, headers, textHeaders, headerRowIndex, firstColumnIndex, existing, rows.length);

  // Write in contiguous runs so a table with formula columns scattered through
  // it costs a handful of setValues() calls rather than one per column.
  for (const run of contiguousRuns(writableIdx)) {
    const startCol: number = run[0];
    const width: number = run[1];
    const block: (string | number | boolean)[][] = [];
    for (const row of rows) {
      const line: (string | number | boolean)[] = [];
      for (let c = startCol; c < startCol + width; c++) {
        line.push(cellValue(row[keys[c]]));
      }
      block.push(line);
    }
    sheet
      .getRangeByIndexes(firstDataRow, firstColumnIndex + startCol, rows.length, width)
      .setValues(block);
  }

  repairFormulaColumns(sheet, headerRowIndex, firstColumnIndex, formulaIdx, needed);

  return rows.length;
}

/**
 * Fill each check column down from the table's prototype row.
 *
 * table.resize() is supposed to extend a table's calculated columns to the new
 * rows. In Excel Online it does not do so reliably — in practice some columns
 * propagate and others don't, which produces a file where the first data row
 * validates correctly and every row below it silently reports OK. Nothing looks
 * broken, which is the worst kind of broken.
 *
 * autoFill with fillCopy replicates row 1's formula down the column, adjusting
 * relative references exactly as dragging the fill handle would.
 *
 * `formulaIdx` is computed in writeBucket from the prototype row, BEFORE any
 * data is written. Recomputing it here would be wrong: after the first chunk,
 * a data column's row 1 holds a literal, and autoFilling a literal down the
 * column would overwrite every row with the first row's value.
 */
function repairFormulaColumns(
  sheet: ExcelScript.Worksheet,
  headerRowIndex: number,
  firstColumnIndex: number,
  formulaIdx: number[],
  dataRows: number
): void {
  if (dataRows < 2) { return; }
  for (const columnIndex of formulaIdx) {
    const source: ExcelScript.Range =
      sheet.getRangeByIndexes(headerRowIndex + 1, firstColumnIndex + columnIndex, 1, 1);
    const destination: ExcelScript.Range =
      sheet.getRangeByIndexes(headerRowIndex + 1, firstColumnIndex + columnIndex, dataRows, 1);
    source.autoFill(destination, ExcelScript.AutoFillType.fillCopy);
  }
}

function applyTextFormat(
  sheet: ExcelScript.Worksheet,
  headers: string[],
  textHeaders: string[],
  headerRowIndex: number,
  firstColumnIndex: number,
  existingRows: number,
  newRows: number
): void {
  if (newRows < 1) { return; }
  for (let i = 0; i < headers.length; i++) {
    if (!isTextHeader(headers[i], textHeaders)) { continue; }
    sheet
      .getRangeByIndexes(headerRowIndex + 1 + existingRows, firstColumnIndex + i, newRows, 1)
      .setNumberFormat("@");
  }
}

/** Grow (or shrink) a table to exactly `dataRows` data rows. */
function resizeTable(table: ExcelScript.Table, dataRows: number): void {
  const current: number = table.getRowCount();
  if (current === dataRows) { return; }
  const range: ExcelScript.Range = table.getRange();
  const sheet: ExcelScript.Worksheet = table.getWorksheet();
  table.resize(
    sheet.getRangeByIndexes(
      range.getRowIndex(),
      range.getColumnIndex(),
      1 + Math.max(1, dataRows),
      range.getColumnCount()
    )
  );
}

/**
 * How many real requests are in this table.
 *
 * Not getRowCount(): a resized table carries rows that have not been written
 * yet, and the prototype row that ships with the template is one of them.
 */
function countFilled(table: ExcelScript.Table, rowKeyHeader: string): number {
  const headers: string[] = headersOf(table);
  const target: string = norm(rowKeyHeader);
  let columnIndex: number = -1;
  for (let i = 0; i < headers.length; i++) {
    if (norm(headers[i]) === target) { columnIndex = i; break; }
  }
  if (columnIndex < 0) {
    throw new Error(
      "Table '" + table.getName() + "' has no '" + rowKeyHeader +
      "' column. Every sheet needs it — it is what the return leg matches on."
    );
  }
  const rowCount: number = table.getRowCount();
  if (rowCount < 1) { return 0; }

  const range: ExcelScript.Range = table.getRange();
  const values: (string | number | boolean)[][] = table
    .getWorksheet()
    .getRangeByIndexes(range.getRowIndex() + 1, range.getColumnIndex() + columnIndex, rowCount, 1)
    .getValues();

  let filled: number = 0;
  for (const row of values) {
    if (asText(row[0]) !== "") { filled++; }
  }
  return filled;
}

/* ==========================================================================
   guards
   ========================================================================== */

/**
 * Fail before writing, not after.
 *
 * The number-format check is the important one. It reads the prototype data row
 * — the row the first written request lands in — so it reflects what the data
 * will actually inherit.
 */
function assertTemplate(
  workbook: ExcelScript.Workbook,
  p: Payload,
  textHeaders: string[],
  rowKeyHeader: string
): void {
  const problems: string[] = [];

  for (const entry of p.typeMap) {
    const table: ExcelScript.Table = workbook.getTable(entry.table);
    if (!table) {
      problems.push("missing table '" + entry.table + "' for type '" + entry.type + "'");
      continue;
    }
    if (!workbook.getWorksheet(entry.sheet)) {
      problems.push("missing sheet '" + entry.sheet + "' for type '" + entry.type + "'");
      continue;
    }

    const rowCount: number = table.getRowCount();
    if (rowCount !== 1) {
      // Exactly one: the prototype row holding the check formulas, which
      // repairFormulaColumns() autoFills from. Zero means no formula source;
      // more than one means the template was saved with test data in it.
      problems.push(
        "table '" + entry.table + "' has " + rowCount +
        " data row(s); it must ship with exactly 1 (the formula prototype row)"
      );
      continue;
    }

    const headers: string[] = headersOf(table);
    if (indexOfHeader(headers, rowKeyHeader) < 0) {
      problems.push("'" + entry.sheet + "' has no '" + rowKeyHeader + "' column");
    }

    const filled: number = countFilled(table, rowKeyHeader);
    if (filled !== 0) {
      problems.push(
        "'" + entry.sheet + "' prototype row already holds a " + rowKeyHeader +
        " value; the template must ship with no request data"
      );
    }

    const sheet: ExcelScript.Worksheet = table.getWorksheet();
    const tableRange: ExcelScript.Range = table.getRange();
    const headerRowIndex: number = tableRange.getRowIndex();
    const firstColumnIndex: number = tableRange.getColumnIndex();

    for (let i = 0; i < headers.length; i++) {
      if (!isTextHeader(headers[i], textHeaders)) { continue; }
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

  if (!workbook.getWorksheet(INSTRUCTIONS_SHEET)) {
    problems.push("missing '" + INSTRUCTIONS_SHEET + "' sheet");
  }

  if (problems.length > 0) {
    throw new Error("Handover template is not usable: " + problems.join("; ") + ".");
  }
}

/* ==========================================================================
   finalize
   ========================================================================== */

/**
 * Hidden metadata, written on the final chunk. This is what lets the return-leg
 * import tell a current file from a stale one, and confirm the file came from a
 * real export rather than being hand-assembled. It costs nothing now and is
 * awkward to add once providers are used to a format.
 *
 * veryHidden rather than hidden: it cannot be unhidden from the Excel UI, only
 * by code. That is integrity, not secrecy — nothing confidential goes here, and
 * ActionedBy is a work email, not personal data (09 §1).
 */
function writeMeta(
  workbook: ExcelScript.Workbook,
  p: Payload,
  cumulativeRows: number,
  totalExpectedRows: number
): void {
  let meta: ExcelScript.Worksheet = workbook.getWorksheet(META_SHEET);
  if (!meta) {
    meta = workbook.addWorksheet(META_SHEET);
  }
  meta.setVisibility(ExcelScript.SheetVisibility.visible);
  meta.getRange("A1:B12").clear(ExcelScript.ClearApplyTo.contents);
  meta.getRange("A1:B9").setValues([
    ["Key", "Value"],
    ["RunId", p.runId],
    ["Country", p.country],
    ["ExportedBy", p.actionedBy ? p.actionedBy : ""],
    ["ExportedUtc", p.exportedUtc],
    ["RowsWritten", String(cumulativeRows)],
    ["TotalExpectedRows", String(totalExpectedRows)],
    ["SchemaVersion", "1"],
    ["GeneratedBy", "BuildRequestSheets"]
  ]);
  meta.getRange("A:B").getFormat().autofitColumns();
  meta.setVisibility(ExcelScript.SheetVisibility.veryHidden);
}

/**
 * Applied last, on the final chunk only. The template ships unprotected so the
 * script can write. If a run fails mid-way the file is left unprotected — but
 * the catch scope deletes partial files, so no unprotected workbook is ever
 * delivered.
 *
 * Workbook structure is protected as well as each sheet. Sheet protection alone
 * still lets a provider delete, rename or reorder tabs, which 06 §5 asks them
 * not to do — and asking is not a control.
 *
 * No password anywhere: this prevents accidents rather than determined edits,
 * and a locked-out provider is a support call you do not want. WHICH cells are
 * unlocked is decided in the template, not here.
 */
function protectWorkbook(workbook: ExcelScript.Workbook, p: Payload): void {
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

  workbook.getProtection().protect();
}

/* ==========================================================================
   helpers
   ========================================================================== */

/**
 * Lowercase, alphanumerics only. Applied to BOTH template headers and payload
 * keys, so "Current ICCID", "current_iccid" and "currentIccid" all collapse to
 * "currenticcid".
 */
function norm(s: string): string {
  if (s === null || s === undefined) { return ""; }
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
  if (v === null || v === undefined) { return ""; }
  return String(v).trim();
}

/**
 * Always written as a string. Combined with the template's "@" number format
 * this is what keeps a 20-digit ICCID intact: Excel carries only 15 significant
 * digits, so a numeric ICCID loses its tail before anyone sees it.
 */
function cellValue(v: Cell): string {
  if (v === null || v === undefined) { return ""; }
  if (typeof v === "boolean") { return v ? "Yes" : "No"; }
  return String(v);
}

function headersOf(table: ExcelScript.Table): string[] {
  return table.getHeaderRowRange().getValues()[0].map((h) => String(h));
}

function indexOfHeader(headers: string[], header: string): number {
  const target: string = norm(header);
  for (let i = 0; i < headers.length; i++) {
    if (norm(headers[i]) === target) { return i; }
  }
  return -1;
}

/** Normalised keys that at least one row in this bucket carries a value for. */
function payloadKeySet(rows: RequestRow[]): Map<string, boolean> {
  const present: Map<string, boolean> = new Map<string, boolean>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      present.set(key, true);
    }
  }
  return present;
}

function contiguousRuns(sortedIdx: number[]): number[][] {
  const runs: number[][] = [];
  if (sortedIdx.length === 0) { return runs; }
  let start: number = sortedIdx[0];
  let prev: number = sortedIdx[0];
  for (let i = 1; i < sortedIdx.length; i++) {
    if (sortedIdx[i] === prev + 1) { prev = sortedIdx[i]; continue; }
    runs.push([start, prev - start + 1]);
    start = sortedIdx[i];
    prev = sortedIdx[i];
  }
  runs.push([start, prev - start + 1]);
  return runs;
}

function isTextHeader(header: string, textHeaders: string[]): boolean {
  if (!textHeaders) { return false; }
  const h: string = norm(header);
  for (const candidate of textHeaders) {
    if (norm(candidate) === h) { return true; }
  }
  return false;
}

/** "0" and 0 must behave identically — see the v3 note 5 at the top. */
function toInt(v: number | string): number {
  if (typeof v === "number") { return Math.max(0, Math.floor(v)); }
  const n: number = parseInt(String(v), 10);
  return isNaN(n) ? 0 : Math.max(0, n);
}

/** "false" is a non-empty string, and every non-empty string is truthy. */
function toBool(v: boolean | string): boolean {
  if (typeof v === "boolean") { return v; }
  return String(v).trim().toLowerCase() === "true";
}
