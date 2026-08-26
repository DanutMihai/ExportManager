# SIM Export Log — list schema, and every write, field by field

List: **SIM Export Log**. One item per export run. Same shape as the import log in
`../SIM Inventory/Logging_System.md`, so both read the same way — but this is a **new flow built
from scratch**; nothing is inherited from the import flow.

**This document is written to be built from with the designer open.** Every write point below gives
the action name, its `Set varStatus` and `Set varMessage` expressions, the complete field list, the
`Respond to a PowerApp` outputs and the `Terminate` status. Nothing is left as "same as above,
except" — that is the phrasing that leaves a field blank.

---

## Why this list exists

Power Automate run history expires — 28 days on most plans. After that, the only record that an
export happened, who ran it, which country's data left the estate and where the file went is
whatever was written to SharePoint. At a bank, "who exported Romania's SIM inventory in March and
where did that file go" is a question that gets asked. This list is the only durable answer.

It is not a nice-to-have. It is the audit trail, and `09_Compliance_and_Data_Protection.md` §4
depends on it existing and being complete.

---

## Actions this document references

All defined in `03_Export_Flow_Spec.md`. Power Automate resolves these by name, so a rename breaks
the expression.

| Reference | Defined in | What it is |
|---|---|---|
| `outputs('Compose_Flow_Identity')` | `03` §5 | Compose holding the run's URL |
| `variables('varThreshold')` | `03` §2 | the sync/async row threshold — an **Integer variable**, not a Compose. `Compose_threshold` does not exist; do not reference it |
| `body('Create_log_item')` | `03` §8 | this list's Create item, for the returned `ID` |
| `outputs('Compose_probe_count')` | `03` §10.5 | row count from the probe |
| `outputs('Compose_error_detail')` | `03` §16.1 | the extracted failure text |
| every `variables('var…')` | `03` §2 | the variable table |

---

## Columns

| Column | Type | Notes |
|---|---|---|
| **Title** | Single line of text | Required by default. `2026-08-13 14:22 UTC · Romania · Requests · 47 rows` |
| **RunId** | Single line of text | **Index this.** |
| **ExportType** | Choice: `Inventory`, `Requests` | **Index this.** Room for `Audit` later. |
| **Country** | Single line of text | **Index this.** |
| **ActionedBy_email** | Single line of text | Text, not Person — survives someone leaving. |
| **Status** | Choice — **seven** values, see below | **Index this.** |
| **Started** | Date and Time | |
| **Finished** | Date and Time | Set on every terminal write. Empty only while `Running` or `Queued`. |
| **DurationSeconds** | Number, 0 decimals | The only way to answer "is `varThreshold` set sensibly". |
| **Rows_Exported** | Number, 0 decimals | Total rows written. |
| **Sheet_Breakdown** | Multiple lines, plain text | `Inventory: 47 rows` / `Requests: 12 rows` — a plain row-count string for both export types. |
| **Delivery** | Choice: `Link returned`, `Emailed`, `None` | Which branch ran. `None` for runs that produced no file — without it a rejected run logs "Link returned" and the field lies exactly where you are trying to read it. |
| **ExportFile** | Hyperlink | The generated workbook's URL, from `varFileUrl` (`03` §11.3). Empty when no file was produced. |
| **FlowRun** | Hyperlink | Run history, while it exists. |
| **Notes** | Multiple lines, plain text | Human-readable summary — mainly the data-quality note on the Inventory path (`03` §13). |
| **ErrorMessage** | Multiple lines, plain text | Catch path only. Separate so you can filter "is not empty". |

### Status — seven values

The flow writes all seven. **SharePoint rejects a value that is not in the choice list**, so a
missing one fails `Update item` on exactly the path where the log matters most.

| Value | Written by | Means |
|---|---|---|
| `Running` | §8 · LOG 1 | The run started. Stays here if it dies without reaching a terminal action. |
| `Invalid` | §10.1 · LOG 1a | Missing or unrecognised input. A user who picked no country is not a flow failure. |
| `Unauthorised` | §10.2 · LOG 1b | `ActionedBy` is not a local admin for the requested country. |
| `No data` | §10.6, §14.1 · LOG 1d / 2 | A successful run that produced no file. **Not an error.** |
| `Queued` | §11.1d · LOG 1e | Async path: the user has been told "we'll email it", the flow is still working. |
| `Completed` | §14.1 · LOG 2 | A file was produced and delivered. |
| `Failed` | §16.2 · LOG 3 | The catch scope ran. |

**Why `Unauthorised` is its own value** rather than folding into `Invalid`: it answers a different
question and has its own view — a rejected authorisation attempt is a security question, not a
"user forgot to pick something" one. Both are invisible if filed as `Invalid`.

**Plain text, not enhanced rich text** on both multi-line columns — rich text stores HTML, which
makes exports and API reads unreadable. **Versioning off** — each item is written twice by design.

### Verify the internal names after creating the list

SharePoint sometimes encodes an underscore as `_x005f_`, so `Rows_Exported` can end up internally as
`Rows_x005f_Exported`. Same failure mode as `Request_x0020_Type`: writes nothing, errors nowhere.
Create the columns with plain names (`RowsExported`), rename them afterwards, then confirm:

```
_api/web/lists/getbytitle('SIM Export Log')/fields?$select=InternalName,Title&$filter=Hidden eq false
```

### Permissions

Read-only for users, write for the flow's connection identity. A log anyone can edit answers no
questions. Connection identity itself: `08_Build_Checklist.md` §3.

---

## The seven write points

```
Trigger · Initialize variables · canonicalise · compose file name
  ▸ LOG 1   Create item                       Running          §8
Scope - Main
  ├ Validate inputs
  │   ▸ LOG 1a  Update log item invalid       Invalid          §10.1   → Respond → Terminate
  ├ Check authorisation
  │   ▸ LOG 1b  Update log item unauthorised  Unauthorised     §10.2   → Respond → Terminate
  ├ Probe
  │   ▸ LOG 1d  Update log item no data       No data          §10.6   → Respond → Terminate
  ├ Async branch
  │   ▸ LOG 1e  Update log item queued        Queued           §11.1d  → Respond, run continues
  ▸ LOG 2   Update item                       Completed / No data  §14.1   ← last action IN the scope
Scope - Catch
  ▸ LOG 3   Update item                       Failed           §16.2
```

Three rules that apply to **every** one of them:

**Wrap every Update in a Condition on `greater(variables('varLogItemId'), 0)`.** If `Create log
item` failed, `varLogItemId` is `0` and `Update item` against ID 0 errors — which, in the catch
scope, means the error handler itself fails. An error handler that can fail is not an error handler.

**Repopulate every field.** SharePoint's `Update item` writes the whole item, so a field left blank
in the action is written as blank, wiping what LOG 1 put there. That is why each table below is
complete rather than a delta.

**Log before responding, respond before terminating.** `Terminate` ends the run immediately —
§14.1 never runs, and `Scope - Catch` does **not** run after a Terminate. Get the order wrong and
the item stays `Running` forever while PowerApps waits for a response that never comes.

---

## Values used everywhere

Two expressions appear in several tables. Defined once here.

**`Id`** on every Update item action:

```
@{variables('varLogItemId')}
```

**`DurationSeconds`** on every terminal write — `ticks()` returns 100-nanosecond intervals, hence
the 10,000,000:

```
@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}
```

---

# LOG 1 — `Create log item` · §8

SharePoint **Create item** · Retry **Exponential, 4**. Immediately after: `Set varLogItemId` =
`body('Create_log_item')?['ID']`, *Configure run after* → **has succeeded** only.

| Field | Value |
|---|---|
| Title | `RUNNING · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')}` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `Running` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | *leave empty* |
| DurationSeconds | `0` |
| Rows_Exported | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `None` |
| ExportFile Url | *leave empty* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `Run started. Awaiting completion.` |
| ErrorMessage | *leave empty* |

Counts as `0` rather than empty: a `Running` row showing blanks looks like a data problem, and a
Number column left empty sorts unpredictably.

`ExportType` and `Country` are written **before** the authorisation check runs. That is deliberate —
a rejected attempt must record *what was attempted*, or the security view is blind.

> **Title uses UTC and says so.** `Started` renders in the site's regional settings — Bucharest is
> UTC+3 — so a title formatted from `varStartedUtc` without the `UTC` suffix sits next to a column
> showing a time three hours different, and reads as a bug. The filename (`03` §6) uses the same
> clock, so a file and its log row always agree.

---

# LOG 1a — invalid input · §10.1

**Condition:** `or(empty(variables('varCountry')), empty(variables('varActionedBy')), empty(variables('varExportType')))`

### `Set varStatus invalid`

```
Invalid
```

### `Set varMessage invalid`

```
concat('Cannot export: ',
  if(empty(variables('varCountry')),'no country was supplied. ',''),
  if(empty(variables('varActionedBy')),'no user was supplied. ',''),
  if(empty(variables('varExportType')),concat('export type "',trim(coalesce(triggerBody()?['text_1'],'(blank)')),'" is not Inventory or Requests. '),''))
```

### `Update log item invalid` — inside `Has log item invalid`

| Field | Value |
|---|---|
| Id | `@{variables('varLogItemId')}` |
| Title | `INVALID · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')}` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `Invalid` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `None` |
| ExportFile Url | *leave empty* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{variables('varMessage')}` |
| ErrorMessage | *leave empty* |

**`Title` and `Country` will often be blank here**, because a blank country is usually why we are on
this path. That is the point: a row saying "the app sent no country" is a bug report about the app.

### `Respond invalid`

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `Invalid` |
| message | `@{variables('varMessage')}` | "Cannot export: no country was supplied." |
| fileUrl | `@{variables('varDownloadUrl')}` | empty |
| shareUrl | `@{variables('varShareUrl')}` | empty |
| rows | `variables('varRowsExported')` | `0` |

### `Set varResponded invalid` → `true` · `Terminate invalid` → **Cancelled**

---

# LOG 1b — not authorised · §10.2

**Condition:** `equals(length(body('Check_authorisation')?['value']), 0)`

### `Set varStatus unauthorised`

```
Unauthorised
```

### `Set varMessage unauthorised`

```
concat('You are not registered as a local admin for ', variables('varCountry'), '. If this is wrong, ask a Super Admin to add you to that country''s row in the SIMRI Country Matrix.')
```

The doubled apostrophe in `country''s` is how a literal single quote goes into a Power Automate
expression. A single one closes the string and the expression will not save.

### `Update log item unauthorised` — inside `Has log item unauthorised`

| Field | Value |
|---|---|
| Id | `@{variables('varLogItemId')}` |
| Title | `UNAUTHORISED · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varActionedBy')}` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `Unauthorised` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `None` |
| ExportFile Url | *leave empty* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{concat('Rejected: ', variables('varActionedBy'), ' is not a local admin for ', variables('varCountry'), ' on the SIMRI Country Matrix, or that country is not Active.')}` |
| ErrorMessage | *leave empty* |

**The Title carries the email as well as the country.** This is the one row type where the *who* is
the whole point, and a title you can scan without opening the item is worth the extra field.

### `Respond unauthorised`

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `Unauthorised` |
| message | `@{variables('varMessage')}` | "You are not registered as a local admin for Romania…" |
| fileUrl | `@{variables('varDownloadUrl')}` | empty |
| shareUrl | `@{variables('varShareUrl')}` | empty |
| rows | `variables('varRowsExported')` | `0` |

### `Set varResponded unauthorised` → `true` · `Terminate unauthorised` → **Cancelled**

---

# LOG 1d — no data · §10.6

**Condition:** the FALSE branch of `greater(outputs('Compose_probe_count'), 0)`.

### `Set varMessage inventory none` *(Inventory branch)*

```
concat('No SIMs found for ', variables('varCountry'), '.')
```

### `Set varMessage requests none` *(Requests branch)*

```
concat('No approved requests found for ', variables('varCountry'), '.')
```

Both export types get the same one-line shape now — the filter already says exactly what "nothing"
means (`RequestType ne 'Delegate'` is baked into the query itself, `03` §10.3), so there's nothing
left to diagnose with a second query the way v3 did.

### `Set varStatus no data`

```
No data
```

### `Update log item no data` — inside `Has log item no data`

| Field | Value |
|---|---|
| Id | `@{variables('varLogItemId')}` |
| Title | `NO DATA · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')}` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `No data` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `None` |
| ExportFile Url | *leave empty* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{variables('varMessage')}` |
| ErrorMessage | *leave empty* |

### `Respond no data`

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `No data` |
| message | `@{variables('varMessage')}` | "No approved requests found for Romania." |
| fileUrl | `@{variables('varDownloadUrl')}` | empty |
| shareUrl | `@{variables('varShareUrl')}` | empty |
| rows | `variables('varRowsExported')` | `0` |

### `Set varResponded no data` → `true` · `Terminate no data` → **Succeeded**

`Succeeded`, not `Cancelled` — "no approved requests" is the process working correctly, and the
run-history failure count is something you will want to trust.

---

# LOG 1e — queued · §11.1d

**The only mid-run write that is not terminal.** The user has been told the file is coming; the
flow keeps working. Without this row a 40-minute export looks stuck to anyone watching the list.

### `Set varStatus queued`

```
Queued
```

### `Set varMessage queued`

```
concat('Export of ', outputs('Compose_probe_count'), '+ rows started. You will receive an email when it is ready.')
```

The `+` is deliberate: the probe fetched `varThreshold + 1` rows and stopped, so it knows the total
is *at least* that, not exactly.

### `Update log item queued` — inside `Has log item queued`

| Field | Value |
|---|---|
| Id | `@{variables('varLogItemId')}` |
| Title | `QUEUED · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')}` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `Queued` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | ***leave empty*** — the run is still going |
| DurationSeconds | `0` |
| Rows_Exported | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `Emailed` |
| ExportFile Url | *leave empty* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{concat('Queued at ', outputs('Compose_probe_count'), '+ rows. Building in the background; the admin will be emailed a link.')}` |
| ErrorMessage | *leave empty* |

**`Finished` stays empty and `DurationSeconds` stays 0** on purpose. Both are filled by LOG 2 when
the run actually ends. A `Queued` row still sitting there tomorrow is a stuck run, and the "Stuck
runs" view finds it precisely because `Finished` is empty.

### `Respond queued` — **the app unblocks here**

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `Queued` |
| message | `@{variables('varMessage')}` | "Export of 2001+ rows started. You will receive an email…" |
| fileUrl | `@{variables('varDownloadUrl')}` | empty — no file exists yet |
| shareUrl | `@{variables('varShareUrl')}` | empty |
| rows | `variables('varRowsExported')` | `0` — nothing written yet |

### `Set varResponded queued` → `true` · **no Terminate** — the flow continues to §11.1g

---

# LOG 2 — `Update log item` · §14.1

Last action **inside** `Scope - Main`, wrapped in `Has log item`. Outside the scope, a failure
sending the email would leave the log claiming `Running` on a run that produced a file.

Reached on the success path **and** on the async path after the email. Also the row that finally
fills `Finished` and `DurationSeconds` for a run that passed through LOG 1e.

### `Set varMessage ready` — set at §11.8, before this

```
concat('Export ready: ', variables('varRowsExported'), ' rows. ', variables('varSheetBreakdown'))
```

### `Update log item`

| Field | Value |
|---|---|
| Id | `@{variables('varLogItemId')}` |
| Title | `@{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')} · @{variables('varRowsExported')} rows` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `@{if(equals(variables('varRowsExported'),0),'No data',variables('varStatus'))}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `@{variables('varRowsExported')}` |
| Sheet_Breakdown | `@{variables('varSheetBreakdown')}` |
| Delivery | `@{if(equals(variables('varRowsExported'),0),'None',if(variables('varAsync'),'Emailed','Link returned'))}` |
| ExportFile Url | `@{variables('varFileUrl')}` |
| ExportFile Description | `@{variables('varFileName')}` |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{variables('varNotes')}` |
| ErrorMessage | *leave empty* |

**`Delivery` comes from `varAsync`, not from a row count.** The sync/async decision was locked in at
§11.1, before the response went out — a run that already responded `Queued` must log `Emailed`
regardless of the final row count, or the field would misreport the delivery it actually used.

**`DurationSeconds` measures to here**, which on the async path is after the email. That is the
number you want: it is how long the work actually took.

`varShareUrl` goes to the email and the response, not to the log — the sharing link is a delivery
artefact, and `varFileUrl` is the stable address of the file itself.

### `Respond ready` — sync path only, §14

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `Completed` |
| message | `@{variables('varMessage')}` | "Export ready: 47 rows. Requests: 47 rows" |
| fileUrl | `@{variables('varDownloadUrl')}` | the `download.aspx` URL — what `Launch()` opens |
| shareUrl | `@{variables('varShareUrl')}` | the org-scoped sharing link, or empty if the action was blocked |
| rows | `variables('varRowsExported')` | `47` |

### `Set varResponded ready` → `true` · no Terminate — the scope ends normally

On the async path there is no Respond here; `Send export email` runs instead, and `varResponded` is
already `true` from LOG 1e.

---

# LOG 3 — `Update log item failed` · §16.2

First real action in `Scope - Catch`, after `Filter array failed actions` and
`Compose error detail`, wrapped in `Has log item failed`.

**Reference nothing inside `Scope - Main` from here.** If the flow failed before that action ran,
the reference is unresolvable and the catch's own Update item fails.
`outputs('Compose_error_detail')` is the single exception and it is built defensively (`03` §16.1).

| Field | Value |
|---|---|
| Id | `@{variables('varLogItemId')}` |
| Title | `FAILED · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · @{variables('varExportType')}` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `Failed` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `@{variables('varRowsExported')}` |
| Sheet_Breakdown | `@{variables('varSheetBreakdown')}` |
| Delivery | `None` |
| ExportFile Url | *leave empty — the partial file is deleted* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{variables('varNotes')}` |
| ErrorMessage | `@{outputs('Compose_error_detail')}` |

**`Rows_Exported` keeps whatever it reached before the failure.** That is how far the run got, and
it is the number that tells you whether anything was written.

**`ErrorMessage` is the extracted failure, not `string(result('Scope_-_Main'))`.** `result()` returns
every action's result including the `Get items` bodies — tens of megabytes of JSON on a 60,000-row
export, pushed into a multi-line text field with a 63,999-character limit. It fails the update or
fills the column with an unreadable wall.

### `Set varMessage failed` — set in the catch, before `Respond failed`

```
concat('The export for ', variables('varCountry'), ' failed and no file was produced. You can safely run it again. Reference ', variables('varRunId'), '.')
```

"You can safely run it again" is a claim the design earns: the partial file is deleted (§16.5), and
since neither export path writes back to its source list, there is nothing left over that a re-run
could conflict with.

### `Respond failed` — only when `equals(variables('varResponded'), false)`

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `Failed` — set by `Set varStatus failed` in the catch |
| message | `@{variables('varMessage')}` | the sentence above |
| fileUrl | `@{variables('varDownloadUrl')}` | empty |
| shareUrl | `@{variables('varShareUrl')}` | empty |
| rows | `variables('varRowsExported')` | whatever was reached |

**If `varResponded` is already `true`** — the async path, where `Respond queued` fired — send
`Send failure email` instead. Only one Respond may execute per run; a second one fails and takes the
whole catch scope down with it, so the user gets silence and nothing is logged.

### `Terminate failed` → **Failed**

---

## Every response the app can receive

One table, so the PowerApps side can be written without reading the flow.

| Path | `status` | `fileUrl` | `shareUrl` | `rows` | App should |
|---|---|---|---|---|---|
| §10.1 invalid | `Invalid` | — | — | 0 | Notify · Error |
| §10.2 not a local admin | `Unauthorised` | — | — | 0 | Notify · Error |
| §10.6 nothing to export | `No data` | — | — | 0 | Notify · Warning |
| §11.1 async started | `Queued` | — | — | 0 | Notify · Information |
| §14 ready | `Completed` | ✔ | ✔ | n | `Launch(fileUrl)` |
| §16.3 failed | `Failed` | — | — | 0 or partial | Notify · Error |

```
Switch(gblExport.status,
  "Completed",    Launch(gblExport.fileUrl),
  "Queued",       Notify(gblExport.message, NotificationType.Information),
  "No data",      Notify(gblExport.message, NotificationType.Warning),
  "Invalid",      Notify(gblExport.message, NotificationType.Error),
  "Unauthorised", Notify(gblExport.message, NotificationType.Error),
                  Notify(gblExport.message, NotificationType.Error)
)
```

The trailing bare `Notify` is the default arm — it catches `Failed` and anything a future version
adds. Full snippet with `IfError` and the busy-state binding in `03` §15.

---

## Views

| View | Filter | Use |
|---|---|---|
| **Failures** | `Status = Failed` | Daily check. |
| **Stuck runs** | (`Status = Running` OR `Status = Queued`) AND `Started < [Today]-1` | Runs that reached neither terminal action. Nothing else surfaces these. `Queued` belongs here: an async run still queued a day later is stuck. |
| **No data** | `Status = No data` | A country repeatedly exporting nothing usually means requests aren't being approved, not that the export is broken. |
| **Rejected attempts** | `Status = Unauthorised` | The security view. Should be empty. If it isn't, the answer is in `ActionedBy_email` and `Country`. |
| **By country, last 30 days** | grouped on Country, `Started >= [Today]-30` | Volume per market. |
| **Threshold tuning** | `Status = Completed`, showing Rows_Exported and DurationSeconds, sorted by rows | Answers `00`'s open item O6 with data instead of a guess. |

Default view sorted by `Started` descending, showing Status, Country, ExportType, Rows_Exported,
Delivery, ActionedBy_email, ExportFile. Keep `Notes` and `ErrorMessage` out of list views — several
hundred characters destroys the layout, and they read fine in the item form.

---

## Alerting — because nobody watches a list

The catch scope logs and responds, but a log with nobody reading it prevents nothing.

Build a **second, scheduled flow** — not an email inside the catch. Once each weekday morning it
runs two queries against this list and mails a digest to `simri_SupportEmail`:

| Query | Why |
|---|---|
| `Status eq 'Failed' and Started gt '<yesterday>'` | the obvious one |
| `(Status eq 'Running' or Status eq 'Queued') and Started lt '<yesterday>'` | the runs that reached neither terminal action — an email inside the catch **cannot** catch these, because the catch never ran |

Send "nothing to report" on a clean day too. A digest that only arrives when something is wrong is
indistinguishable from a digest that has stopped working.

---

## Retention

The log itself: keep it. At a few runs a day it stays small for years, and it is the audit trail. If
it ever needs trimming, delete `Status = Completed` items older than two years and leave every
failure and rejection intact — those are the ones anyone comes back to.

The **files** the log points at are a different question, and a more urgent one: they contain
employee names, GDIDs and delivery addresses. `/SIM Exports/Files` gets a 90-day retention policy —
see `09_Compliance_and_Data_Protection.md` §2. Once files expire, `ExportFile` links 404 while the
log row remains, which is correct and worth knowing before someone reports it as a bug.
