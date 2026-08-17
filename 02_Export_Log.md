# SIM Export Log — list schema and logging points

List: **SIM Export Log**. One item per export run. Same shape as the import log in
`../SIM Inventory/Logging_System.md`, so both read the same way — but this is a **new flow built
from scratch**; nothing is inherited from the import flow.

## Why this list exists

Power Automate run history expires — 28 days on most plans. After that, the only record that an
export happened, who ran it, which country's data left the estate and where the file went is
whatever was written to SharePoint. At a bank, "who exported Romania's SIM inventory in March and
where did that file go" is a question that gets asked. This list is the only durable answer.

It is not a nice-to-have. It is the audit trail, and `09_Compliance_and_Data_Protection.md` §4
depends on it existing and being complete.

---

## Actions this document references

All defined in `03_Export_Flow_Spec.md`. **These references were stale in v2 and are corrected
here** — Power Automate resolves them by name, so a wrong section number sends a developer looking
for an action that moved.

| Reference | Defined in | What it is |
|---|---|---|
| `outputs('Compose_Flow_Identity')` | `03` §5 | Compose holding the run's URL |
| `variables('varThreshold')` | `03` §2 | the sync/async row threshold — an **Integer variable**, not a Compose. `Compose_threshold` no longer exists; do not reference it |
| `body('Create_log_item')` | `03` §8 | this list's Create item, for the returned `ID` |
| `outputs('Compose_error_detail')` | `03` §16.1 | the extracted failure text for `ErrorMessage` |
| every `variables('var…')` | `03` §2 | the variable table |

If you rename any of those actions, the expressions here break.

---

## Columns

| Column | Type | Notes |
|---|---|---|
| **Title** | Single line of text | Required by default. `2026-08-13 14:22 UTC · Romania · Requests · 47 rows` |
| **RunId** | Single line of text | **Index this.** Also written into the workbook's `_Meta` sheet, so a file in someone's inbox traces back to the run that produced it. |
| **ExportType** | Choice: `Inventory`, `Requests` | **Index this.** Room for `Audit` later. |
| **Country** | Single line of text | **Index this.** |
| **ActionedBy_email** | Single line of text | Text, not Person — survives someone leaving. |
| **Status** | Choice — six values, see below | **Index this.** |
| **ReExport** | Yes/No | Default No. A filterable record of every run that deliberately re-sent already-stamped requests. Free text in `Notes` is not an audit trail. |
| **Started** | Date and Time | |
| **Finished** | Date and Time | Empty while `Running` or `Queued`. |
| **DurationSeconds** | Number, 0 decimals | The only way to answer "is `varThreshold` set sensibly". After a month you set the threshold from data instead of from a guess. |
| **Rows_Exported** | Number, 0 decimals | Total written across all sheets. |
| **Rows_Skipped** | Number, 0 decimals | Requests excluded as unmapped or incomplete. `Rows_Skipped gt 0` is a real view filter; the same information buried in `Notes` is not. |
| **Rows_Stamped** | Number, 0 decimals | How many Order List rows were marked handed-over. Should equal `Rows_Exported` on a clean Requests run; a gap means the stamping compensation ran. |
| **Sheet_Breakdown** | Multiple lines, plain text | `New SIM: 12 · Terminate: 3 · Swap: 1`. For Inventory exports, just the row count. |
| **Delivery** | Choice: `Link returned`, `Emailed`, `None` | Which branch ran. `None` for runs that produced no file — without it, a failed run logs "Link returned" and the field lies exactly where you are trying to read it. |
| **ExportFile** | Hyperlink | The generated workbook, from the connector's `{Link}`. Empty when no file was produced. |
| **FlowRun** | Hyperlink | Run history, while it exists. |
| **Notes** | Multiple lines, plain text | Human-readable summary: skipped RequestIDs, unfilled headers, stamping result, data-quality count. |
| **ErrorMessage** | Multiple lines, plain text | Catch path only. Separate so you can filter "is not empty". |

### Status — six values, not four

v2 defined four, and the flow writes six. SharePoint rejects a value that is not in the choice
list, so the missing two would have failed `Update item` on the invalid and queued paths — which
are exactly the paths where the log matters most.

| Value | Written by | Means |
|---|---|---|
| `Running` | `03` §8 | The run started. Stays here if it dies without reaching a terminal action. |
| `Queued` | `03` §11.1d | Async path: the user has been told "we'll email it", the flow is still working. |
| `Completed` | `03` §14.1 | A file was produced and delivered. |
| `No data` | `03` §14.1 | A successful run that produced no file. **Not an error** — "No approved requests for Romania" is a perfectly good outcome, and filing it as `Failed` means the failure view fills with non-problems and people stop reading it. |
| `Unauthorised` | `03` §10.2 | `ActionedBy` is not an admin for the requested country. Its own value, not `Invalid`, so a security question can be answered with a view filter rather than a text search. |
| `Invalid` | `03` §10.1 | Missing or unrecognised input. A user who picked no country is not a flow failure. |
| `Failed` | `03` §16.2 | The catch scope ran. |

**Plain text, not enhanced rich text** on both multi-line columns — rich text stores HTML, which
makes exports and API reads unreadable. **Versioning off** — each item is written twice by design.

### Verify the internal names after creating the list

SharePoint sometimes encodes an underscore as `_x005f_` depending on how the column was created,
so `Rows_Exported` can end up internally as `Rows_x005f_Exported`. Same failure mode as
`Request_x0020_Type`: writes nothing, errors nowhere. Create the columns with plain names
(`RowsExported`), rename them afterwards, then confirm:

```
_api/web/lists/getbytitle('SIM Export Log')/fields?$select=InternalName,Title&$filter=Hidden eq false
```

### Permissions

Read-only for users, write for the flow's connection identity. A log anyone can edit answers no
questions. See `08_Build_Checklist.md` §3 for the connection identity itself.

---

## Logging points

Same three-point pattern as the import, and for the same reason: a run that times out or is
cancelled reaches neither terminal action, and those are the runs worth investigating.

```
Trigger (PowerApps V2)
Initialize variables · canonicalise inputs · compose file name
  ┌──────────────────────────────────────────────┐
  │ LOG 1 — Create item · Status: Running        │   ← before Scope - Main
  │ Set varLogItemId                             │
  └──────────────────────────────────────────────┘
Scope - Main
    Validate inputs · authorise · claim concurrency
      └─ any rejection: Update log item · Respond · Terminate
    Get items (Inventory or Order List, by ExportType)
      └─ no data: Update log item · Respond · Terminate
    Shape · build workbook · assert · stamp
  ┌──────────────────────────────────────────────┐
  │ LOG 2 — Update item · Completed / No data    │   ← last action INSIDE Scope - Main
  └──────────────────────────────────────────────┘
Scope - Catch
  ┌──────────────────────────────────────────────┐
  │ LOG 3 — Update item · Failed                 │
  └──────────────────────────────────────────────┘
    Respond or email · compensate stamps · delete partial file · Terminate
```

**Log 2 goes inside the Scope**, before the response. Outside it, a failure responding to
PowerApps would leave the log claiming `Running` on a run that actually produced a file.

**Every terminating path updates the log before it terminates.** `Terminate` ends the run
immediately — the final `Update item` never runs, and `Scope - Catch` does **not** run after a
Terminate either. Any path that terminates without updating first leaves the item on `Running`
forever, and the "Stuck runs" view fills with people who forgot to pick a country.

**`Respond to a PowerApp` must be reachable on both paths.** If the catch terminates without
responding, PowerApps sits waiting until it times out and the user sees nothing. `03` §16.3 gates
this on `varResponded`, because exactly one Respond may execute per run.

**Wrap every log write in a condition on `greater(variables('varLogItemId'), 0)`.** If `Create
log item` failed, `varLogItemId` is `0` and `Update item` against ID 0 errors — which, in the
catch scope, means the error handler itself fails. An error handler that can fail is not an error
handler.

---

## Field values

### Log 1 — Create item (`03` §8)

Built from the **canonicalised variables**, not from `triggerBody()` directly — `varCountry` and
`varExportType` are trimmed and case-normalised in `03` §2 and §3, and a log Title containing a
raw untrimmed input is a log you cannot group on.

| Field | Value |
|---|---|
| Title | `RUNNING · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')}` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `Running` |
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | *leave empty* |
| DurationSeconds | `0` |
| Rows_Exported · Rows_Skipped · Rows_Stamped | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `None` |
| ExportFile Url / Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `Run started. Awaiting completion.` |
| ErrorMessage | *leave empty* |

Counts as `0` rather than empty: a `Running` row showing blanks looks like a data problem, and a
Number column left empty sorts unpredictably.

Retry: **Exponential, 4**. Then `Set varLogItemId` = `body('Create_log_item')?['ID']`, with
*Configure run after* → **has succeeded** only.

> `ExportType` and `Country` are written before the authorisation check runs. That is deliberate:
> a rejected attempt must record **what was attempted**, or the security view is blind.

> **Title uses UTC and says so.** `Started` renders in the site's regional settings — Bucharest is
> UTC+3 — so a title formatted from `varStartedUtc` without the `UTC` suffix sits next to a column
> showing a time three hours different, and reads as a bug. Either keep the suffix as above or use
> `convertFromUtc(variables('varStartedUtc'),'GTB Standard Time','yyyy-MM-dd HH:mm')`. Pick one and
> use it in the filename too (`03` §6), so a file and its log row carry the same timestamp.

### Log 2 — Update item (`03` §14.1)

Repopulate **every** field. SharePoint's `Update item` writes the whole item, so anything left
blank in the action is written as blank, wiping what Log 1 put there. The repetition is deliberate.

| Field | Value |
|---|---|
| Title | `@{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')} · @{variables('varRowsExported')} rows` |
| Status | `@{if(equals(variables('varRowsExported'),0),'No data',variables('varStatus'))}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `@{variables('varRowsExported')}` |
| Rows_Skipped | `@{variables('varRowsSkipped')}` |
| Rows_Stamped | `@{variables('varStampedCount')}` |
| Sheet_Breakdown | `@{variables('varSheetBreakdown')}` |
| Delivery | `@{if(equals(variables('varRowsExported'),0),'None',if(variables('varAsync'),'Emailed','Link returned'))}` |
| ExportFile Url | `@{variables('varFileUrl')}` — empty when no file |
| ExportFile Description | `@{variables('varFileName')}` |
| Notes | `@{variables('varNotes')}` |
| ReExport | `@{variables('varReExport')}` |
| plus RunId, ExportType, Country, ActionedBy_email, Started, FlowRun | repeated from Log 1 |

**`Delivery` comes from `varAsync`, not from a row count.** The async decision is made on the
*probe count*; rows written is lower after Delegate and skipped rows come out. A probe of 2,100
that writes 1,950 would log "Link returned" for a run that emailed — misreporting exactly at the
boundary the field exists to help you tune.

**`DurationSeconds`** — `ticks()` returns 100-nanosecond intervals, so the divisor is 10,000,000.
Note this measures to Log 2, which on the async path is after the email; that is the number you
want, because it is the number the user waited for.

### Log 3 — Catch (`03` §16.2)

Same fields, with:

| Field | Value |
|---|---|
| Title | `FAILED · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')}` |
| Status | `Failed` |
| Finished | `@{utcNow()}` |
| DurationSeconds | as above |
| Delivery | `None` |
| ExportFile Url / Description | *leave empty — the partial file is deleted* |
| ErrorMessage | `@{outputs('Compose_error_detail')}` |
| Notes | `@{variables('varNotes')}` — carries the stamping-compensation result |

The counters keep whatever they reached before the failure. That is how far the run got.

**`ErrorMessage` is the extracted failure, not `string(result('Scope_-_Main'))`.** `result()`
returns every action's result including the `Get items` bodies — tens of megabytes of JSON on a
60,000-row export, pushed into a multi-line text field with a 63,999-character limit. It fails the
update or fills the column with an unreadable wall. `03` §16.1 extracts and truncates.

**Do not reference any action inside `Scope - Main` from the catch.** If the flow failed before
that action ran, the reference is unresolvable and the catch's own Update item fails.
`Compose_error_detail` is the single exception and it is built defensively.

### Log 1½ — the rejection and queued paths

Three paths update the log mid-run rather than at the end. All use the Log 2 field list with a
different Status, and all are wrapped in the `varLogItemId > 0` condition:

| Path | Status | Delivery | Notes |
|---|---|---|---|
| `03` §10.1 invalid input | `Invalid` | `None` | the `varMessage` naming what was missing |
| `03` §10.2 not authorised / claim rejected | `Unauthorised` | `None` | the `varMessage`, including the country attempted |
| `03` §11.1d queued | `Queued` | `Emailed` | `Queued at <probe count> rows` |

---

## Views

| View | Filter | Use |
|---|---|---|
| **Failures** | `Status = Failed` | Daily check. |
| **Stuck runs** | `Status = Running` OR `Status = Queued`, AND `Started < [Today]-1` | Runs that reached neither terminal action. Nothing else surfaces these. `Queued` belongs here: an async run still queued a day later is stuck. |
| **No data** | `Status = No data` | A country repeatedly exporting nothing usually means requests aren't being approved, not that the export is broken. |
| **Rejected attempts** | `Status = Unauthorised` | The security view. Should be empty. If it isn't, the answer is in `ActionedBy_email` and `Country`. |
| **Needs admin action** | `Rows_Skipped > 0` | Requests that were approved but not sent. These sit unstamped and will keep reappearing until someone fixes the data. |
| **Re-exports** | `ReExport = Yes` | Every deliberate re-send of already-handed-over requests, with who and when. |
| **By country, last 30 days** | grouped on Country, `Started >= [Today]-30` | Volume per market, and the double-handover detector of last resort. |
| **Threshold tuning** | `Status = Completed`, showing Rows_Exported and DurationSeconds, sorted by rows | Answers `00`'s open item O6 with data. |

Default view sorted by `Started` descending, showing Status, Country, ExportType, Rows_Exported,
Rows_Skipped, Delivery, ActionedBy_email, ExportFile. Keep `Notes` and `ErrorMessage` out of list
views — several hundred characters destroys the layout, and they read fine in the item form.

---

## Alerting — because nobody watches a list

The catch scope logs and responds, but a log with nobody reading it is a log that answers
questions after the fact and prevents nothing.

Build a **second, scheduled flow** — not an email inside the catch. Once each weekday morning it
runs three queries against this list and mails a digest to a support address:

| Query | Why |
|---|---|
| `Status eq 'Failed' and Started gt '<yesterday>'` | the obvious one |
| `(Status eq 'Running' or Status eq 'Queued') and Started lt '<yesterday>'` | the runs that reached neither terminal action — an email inside the catch **cannot** catch these, because the catch never ran |
| `Rows_Skipped gt 0 and Started gt '<last 7 days>'` | approved requests that are not reaching providers |

Send "nothing to report" on a clean day too. A digest that only arrives when something is wrong
is indistinguishable from a digest that has stopped working.

---

## Retention

The log itself: keep it. At a few runs a day it stays small for years, and it is the audit trail.
If it ever needs trimming, delete `Status = Completed` items older than two years and leave every
failure, rejection and re-export intact — those are the ones anyone comes back to.

The **files** the log points at are a different question, and a more urgent one: they contain
employee names, GDIDs and delivery addresses. `/SIM Exports/Files` gets a 90-day retention policy.
See `09_Compliance_and_Data_Protection.md` §2. Once files expire, `ExportFile` links 404 while the
log row remains — which is correct, and worth knowing before someone reports it as a bug.
