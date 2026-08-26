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
| 04 | `04_Order_List_Schema.md` | source column names and the Requests export's column map |
| 11 | `11_Country_Matrix_Schema.md` | each country's config and its local admins — the authorisation source |
| 12 | `12_Template_Files.md` | where the two templates really are, and the sensitivity label on both |
| — | `ReadUploadGate.ts` | the Office Script that reads the inventory data-quality gate |
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
| Inventory template | `/Shared Documents/SIMRI Templates/Update_Inventory_tetemplate.xlsx` |
| Requests template | `/Shared Documents/SIMRI Templates/Template Approved SIM Request.xlsx` |
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

**Volume:** Inventory up to 60,000. Requests reads whatever currently matches `Approved` and
non-`Delegate` for the country — no fixed backlog figure, since every run re-reads the current
state rather than draining a queue.

**Both export types are flat, read-only dumps.** The Requests export was originally designed as a
round-trip provider handover workbook — per-type sheets, protected fill-in columns, a stamping
mechanism to stop double handover, a planned return-leg import. None of that was actually needed:
the requirement is "send the country's approved, non-Delegate requests to the provider in bulk,"
the same shape as the Inventory export. Requests now shares Inventory's exact mechanics — one
`Select`, one flat Excel table, the same `CopyRowsIntoTable` script. See `03`'s "What changed from
v3" table for the full list of what this removed.

**Neither export type writes back to its source list.** Nothing is stamped, nothing transitions,
and a re-run returns the same rows again if nothing has changed. Confirmed explicitly for
Requests: no dedup, no write-back to the Order List. Whoever receives the file is responsible for
not re-processing a request they already handled — this flow's job stops at producing an accurate,
current snapshot.

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
duration, and a link to the file. Schema in `02_Export_Log.md`. One item per run, created `Running`
before the work starts, so runs that die without reaching a terminal action still leave a record.

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
Matrix holds a single `Provider` value on a single row per country. The file therefore contains one
country's requests for one provider, and `Provider` is a plain column in the export as confirmation
for the recipient rather than as a grouping key. If that ever stops being true, the failure mode is
provider A receiving provider B's customer list, which is a data-sharing incident rather than a
bug — worth a design conversation before it's ever asked for, not something to guard against now.

---

## Cancelled: the return leg

Earlier drafts planned a future flow that would read a completed provider workbook back, validate
what the provider typed, and update the Order List and Global SIM Inventory accordingly — and built
three things into the export to support it (`RequestID` matching, a hidden `_Meta` sheet, an
`ExportRunId` link back to the Order List). That plan is cancelled, not deferred: once the export
became a flat, one-way bulk file, there was no workbook round trip left for a return-leg import to
read. If a return leg is ever commissioned, it starts from scratch against whatever format the
provider actually returns — not from this file's structure.

---

## Open items

Everything else in this folder is decided. These are not, and each names who can close it.

| # | Item | Blocks | Owner |
|---|---|---|---|
| O1 | The exact `RequestType` choice values, as spelled | the `RequestType ne 'Delegate'` filter in `03` §10.3 | you — one query, `08` §1 |
| O2 | The `OrderStatus` value meaning approved | the export filter in `03` §10.3 | you — same query |
| O4 | Has sending employee names, GDIDs and delivery addresses to an external provider been cleared, and under what retention? | go-live, not build | Data Protection / Compliance — see `09` |
| O6 | Real timing for a 2,000-row export | the value of `varThreshold` | measured on first run, `08` §6 |

Numbering keeps the gaps at O3 and O5 rather than renumbering — both were dropped as part of this
rebuild (O3 was "is Transfer provider-facing and distinct from Delegate," moot once there's no
per-type routing; O5 was "does simInventoryID need to reach the provider," moot once it's just
always a column), and every other document in this folder cites O4/O6 by these exact labels.

O1 and O2 block nothing else in the build — the filter simply won't exclude the right rows until
they're answered. Build everything else first.
