# SIM Exports — design decisions

Working folder for the export flow. Companion to `../SIM Inventory/`, which holds the import side.

**Status:** decisions below are **closed** unless a row says otherwise. Open items live in one
place only — §"Open items" at the bottom of this file. If any other document in this folder
presents one of these as still open, this file wins.

**Read order for a developer building this from scratch:**

| # | File | What it gives you |
|---|---|---|
| 00 | this file | why the flow is shaped the way it is |
| 08 | `08_Build_Checklist.md` | everything that must exist **before** you open the designer |
| 03 | `03_Export_Flow_Spec.md` | the flow, action by action, in build order |
| 02 | `02_Export_Log.md` | the log list schema and the exact field values |
| 04 | `04_Order_List_Schema.md` | source column names and the handover mapping |
| 11 | `11_Country_Matrix_Schema.md` | each country's config and its local admins — the authorisation source |
| 06 | `06_Handover_Template_Spec.md` | what the provider workbook must contain |
| — | `BuildRequestSheets.ts` | the Office Script the flow calls |
| 07 | `07_Flow_Diagram.html` | the same flow as a clickable tree, for orientation |
| 09 | `09_Compliance_and_Data_Protection.md` | what leaves the bank, and under what controls |
| 01 | `01_Edge_Cases.md` | the scenarios each design choice defends against |
| 05 | `05_Review_Findings.md` | historical review of v1 — read only for background |
| 10 | `10_Review_v3_Findings.md` | historical review of v2 — read only for background |

---

## Environment

| | |
|---|---|
| Site | `https://deutschebank.sharepoint.com/sites/simri` |
| Inventory list | Global SIM Inventory · `6b659861-abd0-4e45-b74e-63e3f69f2648` |
| Order list | Global Order List · `e390b86b-13bb-4655-b3e6-efd5bd068279` |
| Country config | SIMRI Country Matrix · `29bf3303-c195-474f-9146-e25d9f0d1b77` |
| Inventory template | `/Documents/SIM_Inventory_TEMPLATE.xlsx` (rename of `SIM_Data_Validation_DEMO.xlsx`) |
| Requests template | `/Documents/SIM_Request_Handover_TEMPLATE.xlsx` |
| Output library | `/SIM Exports/Files` |
| Log list | SIM Export Log |

Do not hard-code any of these into flow actions. `08_Build_Checklist.md` §2 defines the
environment variables that hold them, and why a solution that hard-codes a site URL cannot be
promoted from DEV to PROD without hand-editing.

---

## Decided

**One flow, `ExportType` parameter.** `Inventory` or `Requests`. Shared staging, logging, catch
scope and delivery; only the data shaping differs. The existing inventory export becomes a branch
inside it.

**Delivery: sync under a threshold, email above it.** Small exports return a URL and PowerApps
launches it immediately. Large ones respond "we'll email it" and finish in the background. A
PowerApps flow call times out around 120 seconds, so a 60,000-row inventory export cannot be
synchronous — but making every export async would punish the 200-row case for the sake of the
rare big one.

**Volume:** Inventory up to 60,000. Requests up to 10,000 per country as a one-time backlog;
after the first stamped export per country, the steady state is tens to low hundreds.

**Requests export is a provider handover workbook, not a data dump.** The local admin sends it to
the country's provider, who fills in the operational detail — phone number, ICCID, effective date
— and sends it back. That makes it a round-trip document, so it gets the template treatment:
validated fill-in columns, protected request columns.

**One sheet per request type.** New SIM, Terminate, Swap, Transfer and Change plan each get their
own tab carrying only the columns that type needs. A provider looking at eight columns where
three apply will fill the wrong ones.

**Sheet protection on, no password.** Only the provider fill-in columns are unlocked, and workbook
structure is protected so sheets cannot be added, deleted or reordered. This stops a RequestID or
employee name being altered in transit, which would break the return-leg import. No password: it
prevents accidents rather than determined edits, and a locked-out provider is a support call you
don't want.

**The Requests export writes back — `ExportedOn` and `ExportRunId` are stamped.** This reverses
the original read-only decision, and the reason is in `01` §1: an approved request exported twice
means a second SIM provisioned and a bill for a line nobody asked for. It is the only failure in
this design that costs real money, and the log makes a duplicate *detectable* but not
*prevented*. Stamping prevents it.

Two consequences follow, and both are handled in `03`:

- Stamping happens **after** the file is confirmed written, never before. A build that fails
  after stamping leaves requests marked exported that were never sent — worse than the failure
  being prevented.
- Stamping via `Apply to each` is one API call per row against a ~600-calls-per-60-seconds
  connector limit, which would silently push the sync path past 120 seconds. `03` §12 uses OData
  `$batch` at 100 rows per call instead.

**The Inventory export stays read-only.** Nothing is stamped, nothing transitions. Exporting the
inventory reads; it does not write back.

**Delivery mechanism: `Create sharing link`, scope Organization, type View.** This closes the
question v1 left open. `download.aspx?SourceUrl=…` depends on the user holding read access to the
library, and a permissions gap surfaces as a browser error the app cannot catch. A sharing link
carries its own access grant, so library permissions stop mattering, and it works identically on
the sync and async paths.

> **The provider cannot open an Organization-scoped link.** It is scoped to the bank's tenant, on
> purpose — the file contains employee names and delivery addresses. The link is for the *admin*.
> The admin downloads the workbook and forwards the file itself through whatever channel the
> provider relationship already uses. Do not put the sharing link in an email to a provider; it
> will produce an access-denied page and a support ticket. See `09` §3.

**Audit lives in a SIM Export Log list** — date, who, country, export type, row counts, delivery,
stamped count, duration, and a link to the file. Schema in `02_Export_Log.md`. One item per run,
created `Running` before the work starts, so runs that die without reaching a terminal action
still leave a record.

**Authorisation is a control, not access control.** The flow checks `ActionedBy` against the
country's Local Admin fields on the **SIMRI Country Matrix** — the list the app already maintains,
so there is one source of truth for who administers a country rather than two. `ActionedBy` is a
caller-supplied parameter and a flow callable from the app is callable with any parameters by
anyone the app is shared with, so this raises the bar against casual misuse and produces an audit
trail. It does not close the hole. Recorded as a residual risk in `09` §5 rather than described as
solved.

**One country per export.** The trigger takes a single `Country`. Confirmed: an admin exports one
country at a time. If admins ever become regional and "export all my countries" is asked for, the
change is a `Country` list plus a loop producing one file and one log row per country — see `03`
§20 for the note that will be there when someone goes looking.

**One provider per country.** Not just confirmed — **enforced by the schema**: the SIMRI Country
Matrix holds a single `Provider` value on a single row per country. The workbook therefore contains
one country's requests for one provider, and `Provider` sits in the identity block as a
confirmation for the recipient rather than as a grouping key. If that ever stops being true, `06`
§"If the one-provider-per-country assumption breaks" records what changes — and the failure mode if
it is missed is provider A receiving provider B's customer list, which is a data-sharing incident
rather than a bug.

---

## Planned for, not built yet: the return leg

The provider sends the workbook **back**. That return leg needs a flow that reads the completed
sheets, validates what the provider typed, updates the Order List, and creates the resulting
Global SIM Inventory rows. It is not in scope here, but three things are built into the export
now because retrofitting them means asking providers to switch format:

- **A stable `RequestID` column** on every sheet, protected, used to match on the way back
- **A hidden `_Meta` sheet** (`veryHidden`) carrying RunId, country, who exported, timestamp and
  row count, so the import can tell a current file from a stale one and confirm the file came
  from a real export rather than being hand-assembled
- **`ExportRunId` on the Order List**, matching `_Meta`, so a returned file maps to the rows it
  came from

One correction to carry forward: `00` used to describe the fill-in columns as "validated at
source". They are **guided** at source. Excel data validation never fires on pasted data, on
fill-down, or from a macro, and providers paste. **The return-leg import must revalidate every
field server-side and reject per row.** Do not design it on the assumption the workbook already
enforced anything.

---

## Open items

Everything else in this folder is decided. These are not, and each names who can close it.

| # | Item | Blocks | Owner |
|---|---|---|---|
| O1 | The exact `RequestType` choice values, as spelled | `typeMap`, sheet names, table names in the handover template | you — one query, `08` §1 |
| O2 | The `OrderStatus` value meaning approved | the export filter in `03` §10.3 | you — same query |
| O3 | Is `Transfer` provider-facing, and distinct from `Delegate`? | whether the Transfer sheet exists at all | you / process owner |
| O4 | Has sending employee names, GDIDs and delivery addresses to an external provider been cleared, and under what retention? | go-live, not build | Data Protection / Compliance — see `09` |
| O5 | Does `simInventoryID` need to reach the provider? | one visible column on four sheets | you — `06` §"Columns" |
| O6 | Real timing for a 2,000-row export | the value of `varThreshold` | measured on first run, `08` §6 |

O1, O2 and O3 block the handover template and the `typeMap`; nothing else. Build everything else
first — the flow is written so that an unrecognised `RequestType` is reported as
`unmapped:<value>` and left unstamped rather than silently lost, which means a wrong guess is
visible and recoverable instead of expensive.
