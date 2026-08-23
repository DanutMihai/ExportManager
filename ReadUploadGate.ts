/**
 * ReadUploadGate — reports the data-quality state of a freshly written inventory
 * export, without blocking it.
 *
 * Called once from `Is inventory export` (03_Export_Flow_Spec.md §13), after the
 * write loop and its completeness assertion, before `Switch finalize`.
 *
 * WHAT IT IS FOR
 *
 * The inventory template already computes, per row, whether the ICCID passes a
 * Luhn check, whether the phone number matches its country's dial code, whether
 * the date parses, whether Status and SIM Type are real choice values. That work
 * is done and paid for on every export. This reads the answer back so the flow
 * can put it in the log, which turns every inventory export into a free
 * data-quality audit of that country's estate.
 *
 * IT MUST NEVER FAIL THE EXPORT. The export is a read; the admin may well be
 * exporting *precisely because* they want to see the bad rows. So this script
 * never throws — on any problem it returns available:false with a reason, and
 * the flow reports "could not check" rather than a misleading zero.
 *
 * WHY IT LOOKS FOR THE ANSWER IN FOUR PLACES
 *
 * 03 §13 was written against a named range `UploadGate` at Config!J2 with
 * `UploadGate_ErrorCount` at J3. That pair does NOT exist in
 * SIM_Data_Validation_DEMO.xlsx — that workbook has no defined names at all —
 * and it is unconfirmed in Update_Inventory_tetemplate.xlsx, which is the file
 * the flow actually writes into.
 *
 * Rather than make the flow depend on a cell that may not be there, this script
 * degrades:
 *
 *   1. named range  UploadGate / UploadGate_ErrorCount   ← ideal
 *   2. literal cells Config!J2 / Config!J3               ← named ranges missing
 *   3. Table_query[HasError], counting "ERROR"           ← no gate cell at all
 *   4. Table_query[RowErrors], counting non-empty        ← no HasError column
 *
 * It reports which one it used in `source`, so the first run tells you what the
 * production template actually contains. If it comes back `table:RowErrors`,
 * the gate cells are worth adding — but nothing is broken without them.
 */

interface GateResult {
  available: boolean;
  gate: string;            // OK | BLOCKED | UNKNOWN
  errorCount: number;      // -1 when not available
  rowCount: number;        // data rows carrying an identifier, -1 if unknown
  source: string;          // which of the four routes answered
  sampleErrors: string[];  // up to 3, so the log says WHAT is wrong, not just how much
  note: string;
}

const TABLE_NAME: string = "Table_query";
const GATE_NAME: string = "UploadGate";
const COUNT_NAME: string = "UploadGate_ErrorCount";
const CONFIG_SHEET: string = "Config";
const GATE_CELL: string = "J2";
const COUNT_CELL: string = "J3";
const ROW_KEY_HEADER: string = "FirstName";
const MAX_SAMPLES: number = 3;
const SAMPLE_CHARS: number = 120;

/**
 * @param forceRecalculate Leave false. CopyRowsIntoTable restores calculation to
 *        automatic and does a full rebuild on its last chunk, so by the time this
 *        runs the check columns are current. Set it true only if you ever pass
 *        deferCalculationRestore on that action, or if a test shows stale values —
 *        a full rebuild over 60,000 rows of array formulas is not cheap, and this
 *        script shares the same 120-second budget as every other Run script call.
 */
function main(workbook: ExcelScript.Workbook, forceRecalculate: boolean = false): string {
  const result: GateResult = {
    available: false,
    gate: "UNKNOWN",
    errorCount: -1,
    rowCount: -1,
    source: "none",
    sampleErrors: [],
    note: ""
  };

  if (forceRecalculate) {
    const app: ExcelScript.Application = workbook.getApplication();
    app.setCalculationMode(ExcelScript.CalculationMode.automatic);
    app.calculate(ExcelScript.CalculationType.fullRebuild);
  }

  // ---- 1 and 2: the gate cells, by name then by address --------------------
  const gateText: string = readNamed(workbook, GATE_NAME);
  const countText: string = readNamed(workbook, COUNT_NAME);

  if (gateText !== "" || countText !== "") {
    result.available = true;
    result.gate = normaliseGate(gateText);
    result.errorCount = toCount(countText);
    result.source = "namedRange";
  } else {
    const cellGate: string = readCell(workbook, CONFIG_SHEET, GATE_CELL);
    const cellCount: string = readCell(workbook, CONFIG_SHEET, COUNT_CELL);
    if (cellGate !== "" || cellCount !== "") {
      result.available = true;
      result.gate = normaliseGate(cellGate);
      result.errorCount = toCount(cellCount);
      result.source = "cell:Config!" + GATE_CELL;
    }
  }

  // ---- 3 and 4: compute it from the table ----------------------------------
  // Also runs when the gate cells were found but the count was not a number,
  // because a gate that says BLOCKED without a figure is not much of a report.
  const table: ExcelScript.Table = workbook.getTable(TABLE_NAME);
  if (!table) {
    if (!result.available) {
      result.note = "Table '" + TABLE_NAME + "' not found, and no gate cell either. " +
                    "Nothing to report — check the template.";
    }
    return JSON.stringify(result);
  }

  const headers: string[] = table.getHeaderRowRange().getValues()[0].map((h) => String(h));
  const rowCount: number = table.getRowCount();

  result.rowCount = countFilled(table, headers, rowCount, ROW_KEY_HEADER);

  if (!result.available || result.errorCount < 0) {
    const computed: GateResult = computeFromTable(table, headers, rowCount);
    if (computed.source !== "none") {
      result.available = true;
      result.errorCount = computed.errorCount;
      result.gate = computed.errorCount === 0 ? "OK" : "BLOCKED";
      result.source = result.source === "none"
        ? computed.source
        : result.source + "+" + computed.source;
    }
  }

  // Samples are worth the extra column read: "47 rows fail validation" sends
  // someone hunting, "47 rows fail validation — ICC_ID: Luhn check failed" does
  // not. Read regardless of which route produced the count.
  result.sampleErrors = sampleRowErrors(table, headers, rowCount);

  if (!result.available) {
    result.note = "No UploadGate named range, no Config!" + GATE_CELL +
                  ", and neither a HasError nor a RowErrors column in " + TABLE_NAME +
                  ". The template cannot report data quality as it stands.";
  } else if (result.source.indexOf("table:") === 0) {
    result.note = "Counted from " + result.source.substring(6) +
                  ". Add the UploadGate cells to the template if you want a single-cell answer.";
  }

  return JSON.stringify(result);
}

/* ==========================================================================
   the four routes
   ========================================================================== */

function readNamed(workbook: ExcelScript.Workbook, name: string): string {
  const item: ExcelScript.NamedItem = workbook.getNamedItem(name);
  if (!item) { return ""; }
  const range: ExcelScript.Range = item.getRange();
  if (!range) { return ""; }
  return asText(range.getValues()[0][0]);
}

function readCell(workbook: ExcelScript.Workbook, sheetName: string, address: string): string {
  const sheet: ExcelScript.Worksheet = workbook.getWorksheet(sheetName);
  if (!sheet) { return ""; }
  return asText(sheet.getRange(address).getValues()[0][0]);
}

/**
 * HasError first: it is a single word per row and the intended signal.
 * RowErrors second: non-empty means something failed, which is the same
 * question asked less precisely.
 */
function computeFromTable(
  table: ExcelScript.Table,
  headers: string[],
  rowCount: number
): GateResult {
  const out: GateResult = {
    available: false, gate: "UNKNOWN", errorCount: -1,
    rowCount: rowCount, source: "none", sampleErrors: [], note: ""
  };
  if (rowCount < 1) {
    out.errorCount = 0;
    out.source = "table:empty";
    return out;
  }

  const hasErrorValues: string[] = readColumn(table, headers, rowCount, "HasError");
  if (hasErrorValues.length > 0) {
    let errors: number = 0;
    for (const v of hasErrorValues) {
      if (v.toUpperCase() === "ERROR") { errors++; }
    }
    out.errorCount = errors;
    out.source = "table:HasError";
    return out;
  }

  const rowErrorValues: string[] = readColumn(table, headers, rowCount, "RowErrors");
  if (rowErrorValues.length > 0) {
    let errors: number = 0;
    for (const v of rowErrorValues) {
      // Blank means clean. Some builds write "OK" instead; treat both as clean.
      if (v !== "" && v.toUpperCase() !== "OK") { errors++; }
    }
    out.errorCount = errors;
    out.source = "table:RowErrors";
    return out;
  }

  return out;
}

function sampleRowErrors(
  table: ExcelScript.Table,
  headers: string[],
  rowCount: number
): string[] {
  const samples: string[] = [];
  if (rowCount < 1) { return samples; }
  const values: string[] = readColumn(table, headers, rowCount, "RowErrors");
  for (const v of values) {
    if (v === "" || v.toUpperCase() === "OK") { continue; }
    samples.push(v.length > SAMPLE_CHARS ? v.substring(0, SAMPLE_CHARS) + "…" : v);
    if (samples.length >= MAX_SAMPLES) { break; }
  }
  return samples;
}

/* ==========================================================================
   helpers
   ========================================================================== */

/** One range read of one column, or an empty array if the header is absent. */
function readColumn(
  table: ExcelScript.Table,
  headers: string[],
  rowCount: number,
  header: string
): string[] {
  const index: number = indexOfHeader(headers, header);
  if (index < 0 || rowCount < 1) { return []; }
  const range: ExcelScript.Range = table.getRange();
  const values: (string | number | boolean)[][] = table
    .getWorksheet()
    .getRangeByIndexes(range.getRowIndex() + 1, range.getColumnIndex() + index, rowCount, 1)
    .getValues();
  const out: string[] = [];
  for (const row of values) { out.push(asText(row[0])); }
  return out;
}

/**
 * Real rows, not table rows. CopyRowsIntoTable leaves spareRows blank inside the
 * table so an admin can type below the data without falling out of it, so
 * getRowCount() overstates by up to 200.
 */
function countFilled(
  table: ExcelScript.Table,
  headers: string[],
  rowCount: number,
  header: string
): number {
  let values: string[] = readColumn(table, headers, rowCount, header);
  if (values.length === 0) { values = readColumn(table, headers, rowCount, "ICC_ID"); }
  if (values.length === 0) { return -1; }
  let filled: number = 0;
  for (const v of values) { if (v !== "") { filled++; } }
  return filled;
}

function indexOfHeader(headers: string[], header: string): number {
  const target: string = norm(header);
  for (let i = 0; i < headers.length; i++) {
    if (norm(headers[i]) === target) { return i; }
  }
  return -1;
}

function norm(s: string): string {
  if (s === null || s === undefined) { return ""; }
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function asText(v: string | number | boolean): string {
  if (v === null || v === undefined) { return ""; }
  return String(v).trim();
}

function normaliseGate(s: string): string {
  const u: string = s.toUpperCase();
  if (u === "OK" || u === "BLOCKED") { return u; }
  return u === "" ? "UNKNOWN" : u;
}

/** "" and anything non-numeric come back as -1, never as a misleading 0. */
function toCount(s: string): number {
  if (s === "") { return -1; }
  const n: number = parseInt(s, 10);
  return isNaN(n) ? -1 : n;
}
