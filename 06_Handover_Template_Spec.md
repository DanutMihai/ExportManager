# SIM_Request_Handover_TEMPLATE.xlsx — build spec

What the workbook must contain before `BuildRequestSheets.ts` can write to it. Written after
reading `SIM_Data_Validation_DEMO.xlsx`, because most of this is "do what the inventory template
already does" — that file solved these problems well and the solutions transfer.

**Scope confirmed:** one provider per country, so one workbook per export. The `Provider` column
stays in the identity block as a confirmation for the recipient, not as a grouping key. If that
assumption ever breaks, this is the file that changes first — see the note at the end.

---

## What the inventory template already gets right — carry all of it over

Reading `SIM_Data_Validation_DEMO.xlsx` changed two findings in `05_Review_Findings.md`. Both
were already solved there, and the handover template must inherit the solutions rather than
rediscover them.

**Text-formatted identifier columns (B1).** `PhoneNr`, `ICC_ID` and `IMEI` are all preformatted
`@`. The Readme says why, better than I did:

> HARD ERROR if the cell holds a NUMBER rather than text. Excel carries only 15 significant
> digits, so an 18-22 digit ICCID typed into a General cell is silently truncated —
> 8935201234567890123 becomes 8935201234567900000. The column is preformatted as Text here; do
> the same in your own file BEFORE any data goes in, because by the time you see the error the
> digits are already gone.

That is exactly the requirement. `BuildRequestSheets.assertTemplate()` now enforces it at run
time and refuses to write if any column in `textHeaders` is not `@`.

**Data validation is not enforcement (B2).** Readme line 48:

> Data Validation never fires on pasted data, on fill-down, or from a macro. The conditional
> formatting does, on every recalculation. Treat the colours as the real net.

So the handover template needs the **check columns and conditional formatting**, not just
dropdowns — providers paste, always. And the return-leg import must still revalidate server-side,
because a provider can ignore a red cell.

**The `UploadGate` pattern.** `Config!J2`, named range `UploadGate`:
`=IF(COUNTIF(Table_query[HasError],"ERROR")=0,"OK","BLOCKED")`, with `UploadGate_ErrorCount` at
`J3`. One cell that answers "is this file safe to import?" — see §6 below, and `03` §13 for using
it on the inventory export.

**Excel 2016/2019 compatibility.** INDEX/MATCH rather than XLOOKUP, nested IF rather than IFS, no
LET, no TEXTJOIN, Luhn computed with arithmetic so it needs no array entry. This constraint
matters *more* for the handover template than the inventory one: providers are external and you
have no idea what they're running. Keep it.

---

## Three problems in the inventory template, worth fixing in both

### 1. Validation and conditional formatting stop at row 1966

Every DV and CF range is capped: `E3:E1966`, `C2:C1966`, `AB3:AB1966` and so on. The inventory
export targets **60,000 rows**. From row 1967 onward there is no dropdown, no validation popup and
— more importantly — **no colour**, which the Readme correctly identifies as the real net.

The formula columns are fine: `RowErrors`, `HasError` and `UploadGate` all use structured
references over `Table_query`, so they extend automatically as the table grows. The gate still
tells the truth at 60,000 rows. Only the human-visible layer stops.

Note also that the sync threshold is 2,000 and the formatting stops at 1,966 — so even a
*synchronous* export has 34 uncoloured rows. The two numbers should not be within rounding
distance of each other by accident.

**Recommendation.** Extend DV and CF to a round number you choose deliberately — 5,000 is a
reasonable "a human might actually scroll this" ceiling — and document that beyond it the gate and
the `RowErrors` column are the check, not the colours. Extending CF to 60,000 rows across six
column pairs is possible but bloats the file and slows recalculation on the provider's machine.

For the handover template the practical volumes are much smaller, so cover the full expected
range: **10,000 rows per sheet.**

### 2. Row 2 has stricter validation than rows 3 and below

On the `query` sheet, `E2` carries a DV formula containing `NOT(ISNUMBER($E2))` — the guard
against an ICCID stored as a number. `E3:E1966` carries a different, looser formula:
`AND(ISNUMBER(TRIM($E3&"")+0), …)`, with no text-vs-number guard at all. Same split on `U` (IMEI)
and `G` (StartDate).

Almost certainly an artifact of the table having a single data row when the DV was first applied.
It isn't fatal — `ICC_Check` still catches the numeric case on every row, and the column is
Text-formatted anyway — but the two rules should match, and right now row 2 behaves differently
from every other row for no reason anyone will remember.

### 3. Country dropdowns use static ranges

Readme line 49 flags this honestly: DV and CF reject structured references, so those rules use
`Config!$A$2:$A$51` — static. `tblCountries` currently holds 50 countries. **Add the 51st and it
is silently absent from every dropdown.** Worth a calendar reminder or a note at the top of the
Config sheet, since the failure is invisible.

---

## Sheets

| Sheet | Table | Visible to provider | Notes |
|---|---|---|---|
| `Instructions` | — | ✔ first tab | Protected. See §5. |
| `New SIM` | `tbl_NewSIM` | ✔ | Deleted on finalize if empty |
| `Terminate` | `tbl_Terminate` | ✔ | |
| `Swap` | `tbl_Swap` | ✔ | Two ICCID columns — see §2 |
| `Transfer` | `tbl_Transfer` | ✔ | Pending confirmation it is provider-facing |
| `Change plan` | `tbl_ChangePlan` | ✔ | |
| `Config` | `tblCountries` | hidden | Lookup lists, copied from the inventory template |
| `Checks` | — | hidden | The gate — §6 |
| `_Meta` | — | **veryHidden** | Written by the script on finalize |

**Sheet names must exactly match the `RequestType` choice values** in `typeMap` — confirm them
with the query in `03` §19 before building. A mismatch no longer corrupts anything: the request
comes back in `skipped` with reason `unmapped:<value>` and is left unstamped, so the next export
picks it up. But it does mean nobody gets that request until someone reads the log.

**No `Delegate` sheet, no `Unmapped` sheet, no `Needs attention` sheet.** Delegate is internal.
The other two are admin concerns reported through the flow's response, email and log — putting
them in the provider's workbook was the v1 mistake.

**Every table ships with zero data rows.** Not one blank row like `Table_query` — `addRows`
appends, so a blank first row would reach the provider. `assertTemplate()` refuses to run against
a template with rows in it, which also catches "someone saved the template after testing".

Because the tables are empty, **number formats, cell locking and data validation must be applied
to the whole worksheet column**, not just to a table body that doesn't exist yet. That is what
added rows inherit.

---

## Columns

Every sheet opens with the same protected identity block, then type-specific context, then the
provider's fill-in columns. Header text is authoritative — the script matches headers to payload
keys by normalised name (lowercase, alphanumerics only), so `Current ICCID` binds to
`currentIccid`.

**Identity block, every sheet, all protected:**

`RequestID` · `RequestType` · `GDID` · `Requested for` · `Provider` · `Ticket_ID`

| Sheet | Context (protected) | Provider fills (unlocked) |
|---|---|---|
| New SIM | `SIMType`, `PlanName`, `VRCompatible`, `DeliveryAddress`, `Location` | `PhoneNr`, `ICCID`, `StartDate`, `ProviderNotes` |
| Terminate | `PhoneNr`, `ICCID`, `simInventoryID`, `PlanName` | `EffectiveDate`, `ProviderNotes` |
| Swap | `PhoneNr`, `Current ICCID`, `SIMType`, `newSimType`, `simInventoryID`, `DeliveryAddress` | `New ICCID`, `EffectiveDate`, `ProviderNotes` |
| Transfer | `PhoneNr`, `ICCID`, `simInventoryID`, `TransferdTo`, `PlanName` | `EffectiveDate`, `ProviderNotes` |
| Change plan | `PhoneNr`, `ICCID`, `simInventoryID`, `PlanName`, `NewPlan` | `EffectiveDate`, `ProviderNotes` |

`ProviderNotes` on every sheet is new (`05` §D2). Providers always need to say something —
"number ported, ICCID differs", "address invalid", "line already terminated 03-07". Without a
column for it they write it in an email and the return-leg import never sees it.

**On `simInventoryID` (open question F9).** It is an internal surrogate key the provider cannot
use, present only to survive the round trip. `04`'s own allow-list principle argues for the
narrowest external surface, so consider moving it to a hidden column or to `_Meta` keyed by
RequestID. Left visible above pending your call.

---

## 1. Number formats

Applied to the **whole worksheet column**, and enforced at run time by `assertTemplate()` against
the `textHeaders` payload list:

| Column | Format | Why |
|---|---|---|
| `PhoneNr` | `@` | leading `+` and leading zeros survive |
| `ICCID`, `Current ICCID`, `New ICCID` | `@` | 19–20 digits; Excel keeps 15 |
| `StartDate`, `EffectiveDate` | `@` | see below |
| everything else | General | |

**Dates as Text, not as `dd-mm-yyyy`.** This is the one place the handover template should
*differ* from the inventory one. `SIM_Data_Validation_DEMO.xlsx` formats `StartDate` as
`dd\-mm\-yyyy` — a date format — and `Date_Check` accepts both a real date and dd-mm-yyyy text.
That is right for an internal file where the typist's locale is known. It is wrong here. Readme
line 35 explains why better than I can:

> once Excel has parsed an entry into a real date, the original typing order is gone and nothing
> in the sheet can recover it. If your locale is en-US, typing 15-03-2026 gives 15 March, but
> 03-04-2026 gives 3 APRIL, not 3 April — it becomes March 4th, silently […] Formatting the
> column as Text before entry is the only real defence.

A provider in another country, on an unknown locale, typing a date that is ambiguous under
day-first *and* month-first reading, is precisely the scenario that produces a silently wrong
activation date. Text-format the column and let the strict 10-character `dd-mm-yyyy` check do the
work — which, as the Readme notes, is exactly what keeping the column Text enables.

## 2. The two ICCID columns on the Swap sheet

Header them **`Current ICCID`** (protected, populated) and **`New ICCID`** (unlocked, empty) so
nobody has to guess. Both `@`. The payload carries `currentIccid` and no `newIccid` key, so the
new column comes back in `unfilledHeaders` on every run — expected, and worth knowing so it isn't
mistaken for drift.

## 3. Cell locking

Lock everything by default (Excel's default), then **unlock the fill-in columns for the whole
column**, not just the table body. New rows inherit the column's locked state, so a column
unlocked only across the current table range would produce locked cells on every row the script
adds.

The script's `protectSheets()` applies protection on the final chunk with `allowInsertRows: false`
and `allowDeleteRows: false` — the provider fills cells, they do not restructure the sheet.

No password. `00` already reasoned this out correctly: it prevents accidents rather than
determined edits, and a locked-out provider is a support call you don't want.

## 4. Validation and check columns

Reuse the inventory template's formulas verbatim where they apply — they are already written,
already tested, and already documented in its Readme:

| Fill-in column | Reuse | Notes |
|---|---|---|
| `ICCID` / `New ICCID` | `ICC_Check` | digits only, starts `89`, length 18–22, Luhn, numeric-cell hard error |
| `PhoneNr` | `IsPhoneValid` + `PhoneClean` | needs the country on the row — see below |
| `StartDate` / `EffectiveDate` | `Date_Check` | strict 10-char dd-mm-yyyy, real calendar date |

**`IsPhoneValid` needs a country column.** It compares the number's prefix against
`tblCountries[DialCode]` matched on `SIM_Country`. The handover sheets have no country column —
there is one country per file. Two options: add a hidden `Country` column populated by the script
from `payload.country`, or hard-code the dial code into a `Checks` sheet cell at export time.
The hidden column is simpler and keeps the formula unchanged.

**Keep the `WARNING:` prefix convention.** The amber conditional-formatting rule tests
`LEFT(x,8)="WARNING:"`, so any new warning that keeps the prefix colours itself. Cheap
consistency, and the Readme already tells whoever comes next how it works.

**Add a `RowErrors` column per sheet**, same construction as the inventory one: concatenation
rather than TEXTJOIN, so it runs on Excel 2016. This is the column the provider actually reads.

## 5. The `Instructions` sheet

First tab, protected, modelled on the inventory `Readme` — which is genuinely good and sets the
right precedent. It needs to cover:

- What to fill in: only the unlocked columns, which are visually distinct
- **Paste values only** — pasting formatted cells can overwrite the Text format and destroy ICCIDs
- The date format, with an example: `05-03-2026`, and that `5-3-2026` is rejected
- Do not add, delete or reorder rows or columns; do not rename sheets
- What the colours mean — green OK, red fix it, amber probably wrong
- Who to send the file back to, and that the filename must not be changed
- The RunId, so a returned file can be traced to its export

Note this file goes to an external party, so keep the internal-jargon level lower than the
inventory Readme's.

## 6. The `Checks` sheet — one cell that answers "is this safe to import?"

Reuse the `UploadGate` idea directly. On a hidden `Checks` sheet, one named range per sheet plus a
roll-up:

```
ReturnGate        =IF(SUM(ErrorCounts)=0,"OK","BLOCKED")
ReturnErrorCount  =SUM(ErrorCounts)
FilledRowCount    =COUNTA(tbl_NewSIM[ICCID]) + …
```

The return-leg import then reads two cells instead of parsing every row of every sheet to find out
whether it should bother. Same pattern, same reasoning, already proven on the import side.

---

## 7. Before it ships to an external provider

Four things the inventory template carries that should not leave the bank:

**Strip the web-extension reference.** The workbook has `xl/webextensions/taskpanes.xml` pinning
an Office add-in, including a `claude.fileId` property. Harmless internally; odd in a file sent to
a supplier, and it can prompt on open. Remove the pinned task pane and re-save.

**Clear document properties.** `docProps/core.xml` carries `lastModifiedBy: Ilie Danut Mihai`.
File → Info → Check for Issues → Inspect Document → remove personal information.

**Remove the sample rows and the notes column.** The copy I read is already clean —
`Table_query` is `A1:AC2` and column `AD` is empty — but the Readme references "33 sample rows"
and a grey notes column, so a different copy may still have them. Worth confirming on whichever
file is actually in `/Documents`.

**Rename the file.** `SIM_Data_Validation_DEMO.xlsx` is a production dependency of a flow. The
word DEMO in the name invites exactly one kind of accident.

---

## If the one-provider-per-country assumption breaks

Recorded here because this is the file that changes:

`BuildRequestSheets` would group by `payload.requests[].provider` and the flow would loop,
producing one workbook per provider with the provider name in the filename and one log row per
file. The script's routing already buckets rows before writing, so the change is a second grouping
level rather than a redesign — but the flow's single-file assumptions (`varFileName`, `varFileUrl`,
one `Create export file`, one log item) would all become collections.

Cheaper to do then than to discover a provider received another provider's customer list.
