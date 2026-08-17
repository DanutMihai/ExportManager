# Export flow — review of v2, and what changed in v3

Review of `00`–`07` plus `BuildRequestSheets.ts`, 17-08-2026, cross-checked against
`../SIM Inventory/`. Ordered by cost of finding it late.

**Verdict.** The v2 design is right and the reasoning behind it is better than most production
Power Automate work — the probe-then-decide pattern, the three-point logging, `No data` as its own
status, the allow-list on columns, the `$batch` stamping and the `varResponded` guard are all
correct, and several are the kind of thing people only get right after being burned once.

What follows is what would still have gone wrong. Four of these are **build-blocking**: the flow
either will not save or will not run. Three are **silent** — they produce a result that looks
completely normal and fails weeks later, at a provider. The silent ones are the expensive ones.

Everything below is applied. This document exists so the changes are reviewable, not so they are
outstanding.

---

## A. Build-blocking — the flow will not save or will not run

### A1. Duplicate action names in two Switch statements

`03` v2 §11.1g specified "each ending `Set varItems full`", and §11.4 gave both Switch cases an
action called `Set varShaped`. `07`'s diagram shows the same, twice.

**Power Automate action names are globally unique across a flow, including across the branches of a
Switch.** The designer refuses the second one. There is no clever workaround; they need different
names.

**Fixed:** `Set varItems inventory full` / `Set varItems requests full`, and
`Set varShaped inventory` / `Set varShaped requests`. `03` §11.1 and §11.4, and the naming rule is
now stated at the top of the document rather than left to be discovered.

### A2. `where()` is not a Power Automate function

`03` v2 §16.1 — the catch scope's error extraction — was built on:

```
first(where(result('Scope_-_Main'), equals(item()?['status'],'Failed')))
```

There is no `where()` in the workflow definition language. The collection functions are
`contains, empty, first, intersection, item, join, last, length, reverse, skip, sort, take, union`.
Filtering a collection needs the **Filter array** action.

The expression cannot be saved, which means **the error handler cannot be built as written** — and
this is the one action whose failure leaves you with no log, no message and no idea what happened.
It came from `05` §C4, which invented the function while fixing a real problem.

**Fixed:** `03` §16.1 is now a `Filter array failed actions` action followed by a `Compose`.

### A3. `substring()` throws when the string is shorter than the requested length

Same expression: `substring(…, 0, 2000)` on an error message of 40 characters is an error inside
the error handler.

This is a regression from a pattern the import side already got right —
`../SIM Inventory/Logging_System.md` guards its 60,000-character truncation with
`if(greater(length(…),60000), substring(…), …)`.

**Fixed:** length guard in `03` §16.1. Also fixed the related `coalesce` problem: an empty string
is not null, so `coalesce('', variables('varMessage'))` returns the empty string rather than
falling through. The fallback chain is now explicit `greater(length(…),0)` tests.

### A4. The concurrency claim makes every Requests export reject itself

`03` v2 §12.6 rejects if a `Running` Requests export exists for the same country in the last 30
minutes.

But `Create log item` (§8) runs **before** `Scope - Main` and writes `Status = Running`. By the
time the claim query runs, the flow's own log item matches its own filter. Every Requests export
finds itself and refuses to run. One hundred percent reproducible, on the very first test.

**Fixed:** `03` §10.2b adds `and ID lt @{variables('varLogItemId')}`, so a run only defers to an
export that started *before* it did. That also resolves the simultaneous-click case
deterministically — one winner, one clear message — rather than both rejecting each other, which
"any running export" would have produced.

---

## B. Silent — the output looks perfectly normal

These are the ones worth the review.

### B1. `BuildRequestSheets` destroys every check formula in the provider's workbook

The v2 script built a value for **every header** in the table and wrote the full width with
`addRows()`. Any header with no matching payload key got `""`.

The headers with no matching payload key are the check formula columns — `ICC_Check`,
`Date_Check`, `IsPhoneValid`, `PhoneClean`, `RowErrors`, `HasError` — and the provider's fill-in
columns. Writing `""` over a formula replaces it with a literal. **Excel does not restore it.**

After one export the provider's workbook has:

- no red cells, no amber cells, no colours at all
- `RowErrors` blank on every row
- `HasError` blank, so the `ReturnGate` cell reads OK over anything
- data validation still firing on typed entry, which makes it look like a *formatting* problem

Every document in this folder — `00`, `01` §4, `06` §4, and the Readme quoted in `06` — says the
colours are the real net and the validation is only guidance. The script silently removed the net,
and the file looks completely fine.

The import side already solved this. `../SIM Inventory/CopyRowsIntoTable_fixed.ts` opens with the
same finding as its change #1, in almost the same words.

**Fixed:** `BuildRequestSheets.ts` rewritten to the `CopyRowsIntoTable` pattern — classify headers
against the payload once, write only the data columns in contiguous runs, step over everything
else, then `autoFill` the check columns down from a prototype row. Consequences documented in
`06`: each table now ships with **exactly one** data row holding the formulas, and
`assertTemplate()` enforces it.

### B2. `finalize` fires on the first chunk

`03` v2 §11.5's table gave `Compose is final chunk` as:

```
lessOrEquals(add(varChunkOffset, length(Compose_chunk)), length(varShaped))
```

That is true for **every** chunk, first included. The note two paragraphs below gave the correct
`greaterOrEquals` version — but the table is what gets copied into the designer.

Consequence: chunk 1 writes `_Meta`, deletes every currently-empty tab, and protects the sheets.
Chunk 2 then writes into a protected sheet, or into a table whose worksheet no longer exists.

**Fixed:** `03` §11.5b now shows one expression, and it emits the literal string `'true'` /
`'false'` — see B3 for why that form specifically.

### B3. The payload's types silently change the script's behaviour

The script's parameter is a string that it `JSON.parse`s. v2 did not say how to build it, and the
natural designer approach — a Compose containing a JSON object with `@{…}` interpolation — produces
**quoted** values:

- `"startRowIndex":"0"` → `p.startRowIndex === 0` is `false` → **`assertTemplate()` never runs.**
  That is the guard that refuses to write when an ICCID column has lost its Text format. The export
  succeeds and truncates every ICCID past the 15th digit.
- `"finalize":"false"` → `"false"` is a non-empty string → **truthy in JavaScript** → every chunk
  finalizes. B2 again, by a different route.

Two different paths to the same silent corruption, from a detail nobody would think to check.

**Fixed:** `03` §17 specifies `string(json(concat(…)))` — the same construction the import flow
already uses — with numbers and booleans unquoted, and explains what each mis-typed value does.
The script also coerces both defensively (`toInt`, `toBool`), so a future payload change cannot
reintroduce it.

### B4. All-requests-skipped delivers an empty workbook as a success

If the probe finds rows but the script routes every one of them to `skipped` — all unmapped, or all
missing a mandatory field — then:

- a file was created (§11.3 runs before the script)
- every request sheet is empty, so finalize deletes all five
- `cumulativeRows` is 0

v2 then set `varMessage` = "Export ready: 0 rows", returned a working URL, and logged `No data` —
on a run that produced a file. The admin gets a link to a workbook containing nothing but the
Instructions sheet, and a message that says it worked.

This is `05` §B4's bug — three counters disagreeing — surviving in a form the `Delegate` filter
does not cover.

**Fixed:** `03` §11.7a deletes the file, sets a message naming what was rejected and why, and
terminates. The requests stay unstamped, so fixing the data and re-exporting picks them up.

### B5. A partial stamping failure marks requests as sent that were never sent

`03` v2 §12.5g correctly checks the `$batch` response for failed operations inside an HTTP 200 —
that part is good, and it is a real trap. But on failure it forces the run into the catch, which
deletes the file.

Batches already sent stay committed. So: batch 7 of 20 fails, the file is deleted, and 600
requests carry `ExportedOn` and `ExportRunId` for an export the provider never received. They will
never appear in another export. Nobody finds out until an employee asks where their SIM is.

`00` and `05` both state the principle — *"if the build fails after stamping, requests are marked
exported and were never sent, a worse failure than the one being prevented"* — and then the design
allows exactly that, half-way through.

**Fixed:** `03` §16.6 compensates. Because §12.2 stamps one `ExportRunId` for the whole run, the
rows to undo are exactly identifiable: query `ExportRunId eq '<runId>'` and PATCH both fields back
to null. `08` §7 documents the manual version for the case that cannot be automated — an
administrator cancelling the run, where neither the catch nor the compensation executes.

---

## C. Correctness and security

### C1. `ActionedBy` is not escaped before it reaches an OData filter

`03` v2 §10.2 built the authorisation filter with `Email eq '@{variables('varActionedBy')}'`.
`Country` was escaped for the `Côte d'Ivoire` case; `ActionedBy` was not.

`ActionedBy` is caller-supplied. A value like `x' or Country ne '` closes the string and appends a
clause, and the filter returns a row — which is to say **the authorisation check passes**.

The check is explicitly not an access control (R1 in `09`), so this is not a hole into otherwise
solid ground. But a control that can be trivially bypassed by its own input is worse than one whose
limits are documented, because the audit trail it produces becomes untrustworthy too.

**Fixed:** `03` §2 and §4a escape every caller-supplied value once, into `varCountryOData` and
`varActionedByOData`, and every filter uses those. `08` §6 test 4 includes the injection string.

### C2. `Limit Columns by View` drops `ID`

`03` v2 §10.4 says to point column limiting at a view containing "only the exported columns". `ID`
is not returned automatically when column limiting is on and is easy to leave out of a view built
from the export map.

Without it: `item()?['ID']` is null → `requestId` is empty on every row → the workbook's
`RequestID` column is blank (breaking the return leg) and `Select stamp ids` produces a list of
empty strings (so nothing is stamped, and the double-handover guard silently does nothing).

**Fixed:** stated in `03` §10.4 and specified concretely in `08` §1.5, which lists all three views'
exact contents.

### C3. The hidden `Country` column had no way to be populated

`06` §4 requires a hidden `Country` column on each handover sheet so `IsPhoneValid` can match a
dial code. The script populates columns by matching headers to payload keys — and the payload
carried `country` only at the top level, not per row.

So the column would come back in `unfilledHeaders`, stay blank, and every phone number the provider
types would validate against nothing. The check would appear to be working.

**Fixed:** `"country": "@{variables('varCountry')}"` added to the Select map in `03` §11.4, and
`04` explains why one key in the map has no source column.

### C4. New SIM's fill-in columns would be pre-filled from the Order List

`PhoneNr`, `ICCID` and `StartDate` are the provider's to fill on the New SIM sheet, but they are
protected *context* columns on every other sheet — so the payload carries keys of those names, and
header matching would populate them wherever they appear.

Usually harmless, because those fields are empty on a new request. Not always, and "usually empty"
is not a design.

**Fixed:** `blankHeaders` per `typeMap` entry (`03` §17), forcing them empty on New SIM only.

### C5. The log's `Status` choice column was missing two of the values the flow writes

`02` v2 defined four values. The flow writes `Queued` (§11.1d) and `Invalid` (§10.1). SharePoint
rejects a value that is not in the choice list, so `Update item` fails on exactly the two paths
where the log matters most — a queued long-running export, and a rejected input.

**Fixed:** `02` now defines seven, adding `Queued`, `Invalid` and `Unauthorised`. The third is new:
a rejected authorisation attempt logged as `Invalid` is indistinguishable from a user who forgot to
pick a country, which makes the security question unanswerable by filter.

### C6. `02` contradicted `03` on three points it is the authority for

`02` is where a developer looks up the exact field values, and it still carried v1 content that
`03` v2 had already corrected:

- `Delivery = if(greater(varRowsExported, outputs('Compose_threshold')), …)` — the wrong derivation
  (`05` §B5), referencing an action that no longer exists
- `ErrorMessage = @{string(result('Scope_-_Main'))}` — the tens-of-megabytes problem (`05` §C4)
- an action-reference table pointing at §2a, §2c, §3 and §8, none of which are where those actions
  live in v2 — flagged as `05` §E10 and never applied

The document opens by warning that renaming an action breaks these expressions, which makes the
reference table the one place that has to be right.

**Fixed:** `02` rewritten. Also picked up `05` §E3 (`DurationSeconds`) and §E11 (timezone in the
Title), and added `ReExport`, `Rows_Skipped` and `Rows_Stamped` as filterable columns rather than
free text buried in `Notes` — `09` §4 depends on those three being queryable.

---

## D. Production-readiness gaps

None of these would fail a first test. All of them would surface between UAT and the first audit.

### D1. Hard-coded environment values

`03` v2 hard-coded the site URL in three expressions, the Order List GUID inside the `$batch` body,
and left `<envId>` as a literal placeholder in the run-URL Compose.

A solution like that cannot be promoted DEV → UAT → PROD without hand-editing expressions, and the
list GUID sits inside a composed HTTP body where no connector validation would catch a stale value.
A test run against production data is one missed edit away.

**Fixed:** environment variables throughout, defined in `08` §2, with the single-Compose fallback
named for environments where they are not available.

### D2. No monitoring

`05` §E4 recommended it; nothing was specified. The catch scope logs and responds, and nobody reads
a SharePoint list.

**Fixed:** `02` §Alerting and `03` §19 specify a scheduled digest flow. The point that makes it a
separate flow rather than an email inside the catch: **a run that reaches neither terminal action
never runs the catch**, so an in-catch email cannot report the failures that are hardest to see.

### D3. No test plan, no runbook, no deployment steps

The spec described what to build with unusual care and said nothing about how to know it works,
what to check before go-live, or what to do at 2am when a stamping run half-completed.

**Fixed:** `08` — 25 tests in dependency order, a symptom-to-recovery runbook, a DLP and connection
checklist, and a go-live list. The tests most likely to be skipped are called out as such: full
volume (8), forced stamping failure (18) and simultaneous exports (19).

### D4. The `Country Admins` list was referenced but never defined

`03` §10.2 filtered it on `Email` and `Country`. No schema, no note on whether it exists.

**Fixed, then fixed better.** `08` §1.4 first said to check whether the app already stored the Local
Admin role somewhere. It does: the **SIMRI Country Matrix**, one row per country, with Local Admin
1, 2 and an optional group. §10.2 now reads that, `08` §1.4 says to build nothing, and `11` records
the schema — including that ten of its columns are `field_N` internal names that cannot be inferred
from their display names, and that `LinkTitle` displays as *CountryCode* but is computed and cannot
be filtered.

### D5. `Create sharing link` could fail the whole export

Organisation-scoped link creation can be blocked by tenant policy. In v2 that failure would fail
`Scope - Main` **after** the file was built and immediately before stamping — destroying a
completed export because of a policy setting.

**Fixed:** `03` §11.8 continues on failure and falls back to the download URL. Same treatment for
`Run ReadUploadGate` in §13: a data-quality nicety must never fail the export it is reporting on.

### D6. Documents contradicted each other on decided questions

`00` still said *"The export stays read-only. No stamping of ExportedOn… Exporting reads; it does
not write back"* — the exact opposite of `03` §12. `01` still presented §1 as **DECIDE**, still
said to route unmapped requests to a tab inside the provider's workbook (reversed in v2), and still
recommended trigger concurrency 1 (rejected in v2). `04` still presented `EffectiveDate` as an open
choice that `03` §0 had already acted on.

A developer reading in order would get contradictory instructions on the single most important
design decision in the flow.

**Fixed:** `00`, `01` and `04` rewritten to state decisions as decided, with open items collected
in exactly one place (`00` §Open items) and a read order at the top of `00`. `05` carries a banner
marking it historical.

### D7. No compliance record

`05` §F4 asked whether sending employee names, GDIDs and delivery addresses to an external provider
had been cleared. It was never answered and never written down.

**Fixed:** `09` — what leaves and what does not, the minimisation control and why the allow-list
direction matters, retention, the fact that **the organisation-scoped link is unusable by the
provider** so the real transfer is an unmanaged email, the audit trail, and five residual risks
recorded plainly rather than implied to be closed.

---

## E. Smaller things, all applied

| # | Item | Where |
|---|---|---|
| E1 | `varRowsSkipped` added — `02` needs it as a column | `03` §2, §11.7 |
| E2 | `Append to string variable` replaces self-referencing `Set variable`, matching the import flow | `03` §12.6, §13 |
| E3 | `Compose text headers` / `Compose type map` hoisted to root level so the loop doesn't rebuild them 120 times | `03` §17 |
| E4 | `03` §11.4 cross-referenced §16 (Scope - Catch) where it meant §17 | `03` §11.4 |
| E5 | `requestId` documented as a string on both sides, with what breaks if someone "improves" it to an int | `04`, `03` §12.3 |
| E6 | Workbook **structure** protection added — sheet protection alone still lets a provider delete or reorder tabs | `BuildRequestSheets.ts`, `06` §3 |
| E7 | `_Meta` gains `ExportedBy` | `BuildRequestSheets.ts`, `06` |
| E8 | Text number format applied **before** values are written, not after | `BuildRequestSheets.ts` |
| E9 | Calculation mode managed and restored on finalize — a workbook shipped in manual mode shows stale checks to an external party who cannot be told to press F9 | `BuildRequestSheets.ts` |
| E10 | `IfError` around `SIMExports.Run` in PowerApps — without it a pre-response failure leaves the Export button disabled | `03` §15 |
| E11 | The "no data" and "nothing written" paths terminate with `Succeeded`, not `Cancelled` — neither is a failure | `03` §10.6, §11.7a |
| E12 | Diagnostic query documented as informational and capped at 5,000 | `03` §10.6 |
| E13 | `RequestType ne 'Delegate'` — flagged that CAML `Neq` typically excludes null, so a blank type would vanish rather than be reported | `03` §10.3, `08` §6 test 4 |
| E14 | Scale caveat on holding 60,000 rows in `varItems` + `varShaped` and slicing per iteration, with the import flow's paging pattern named as the fallback | `03` §11.1 |
| E15 | DLP note on `Send an HTTP request to SharePoint`, with the fallback if it is blocked | `03` §12.5, `08` §3 |
| E16 | Warning to check whether admins link to `SIM_Data_Validation_DEMO.xlsx` before renaming it | `03`, `08` §1.7 |

---

## What was already right and should not be changed

Worth stating, because a rewrite this size can read as though everything was wrong.

The one-flow-with-a-parameter decision. The probe-then-decide pattern and fetching threshold + 1.
The sync/async split and responding before the work finishes. Three-point logging with the item
created up front. `No data` as its own status rather than a failure. The allow-list on exported
columns. `varResponded` and `varFileCreated` as the catch scope's guards. Retry `None` on the
script actions and Exponential/4 on the reads. The `$batch` stamping with a response check, and
stamping only after the file is confirmed written. The `_Meta` sheet. Taking URLs from the
connector instead of building them. Keeping unmapped and incomplete requests out of the provider's
workbook. Reading `UploadGate` for a free data-quality audit — that one is genuinely clever and
costs one script call.

Several of those only look obvious after someone has already made the other choice.
