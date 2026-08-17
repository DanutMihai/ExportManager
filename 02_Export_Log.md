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
| `body('Claim_concurrency')` | `03` §10.2b | the earlier running export, for the "already running" message |
| `outputs('Compose_probe_count')` | `03` §10.5 | row count from the probe |
| `outputs('Compose_error_detail')` | `03` §16.1 | the extracted failure text |
| every `variables('var…')` | `03` §2 | the variable table |

---

## Columns

| Column | Type | Notes |
|---|---|---|
| **Title** | Single line of text | Required by default. `2026-08-13 14:22 UTC · Romania · Requests · 47 rows` |
| **RunId** | Single line of text | **Index this.** Also written into the workbook's `_Meta` sheet, so a file in someone's inbox traces back to the run that produced it. |
| **ExportType** | Choice: `Inventory`, `Requests` | **Index this.** Room for `Audit` later. |
| **Country** | Single line of text | **Index this.** |
| **ActionedBy_email** | Single line of text | Text, not Person — survives someone leaving. |
| **Status** | Choice — **eight** values, see below | **Index this.** |
| **ReExport** | Yes/No | Default No. A filterable record of every run that deliberately re-sent already-stamped requests. Free text in `Notes` is not an audit trail. |
| **Started** | Date and Time | |
| **Finished** | Date and Time | Set on every terminal write. Empty only while `Running` or `Queued`. |
| **DurationSeconds** | Number, 0 decimals | The only way to answer "is `varThreshold` set sensibly". |
| **Rows_Exported** | Number, 0 decimals | Total written across all sheets. |
| **Rows_Skipped** | Number, 0 decimals | Requests excluded as unmapped or incomplete. `Rows_Skipped gt 0` is a real view filter; the same information buried in `Notes` is not. |
| **Rows_Stamped** | Number, 0 decimals | Order List rows marked handed-over. Should equal `Rows_Exported` on a clean Requests run; a gap means the compensation ran. |
| **Sheet_Breakdown** | Multiple lines, plain text | `New SIM: 12 · Terminate: 3 · Swap: 1`. For Inventory, just the row count. |
| **Delivery** | Choice: `Link returned`, `Emailed`, `None` | Which branch ran. `None` for runs that produced no file — without it a rejected run logs "Link returned" and the field lies exactly where you are trying to read it. |
| **ExportFile** | Hyperlink | The generated workbook, from the connector's `{Link}`. Empty when no file was produced. |
| **FlowRun** | Hyperlink | Run history, while it exists. |
| **Notes** | Multiple lines, plain text | Human-readable summary: skipped RequestIDs, unfilled headers, stamping result, data-quality count. |
| **ErrorMessage** | Multiple lines, plain text | Catch path only. Separate so you can filter "is not empty". |

### Status — eight values

The flow writes all eight. **SharePoint rejects a value that is not in the choice list**, so a
missing one fails `Update item` on exactly the path where the log matters most.

| Value | Written by | Means |
|---|---|---|
| `Running` | §8 · LOG 1 | The run started. Stays here if it dies without reaching a terminal action. |
| `Invalid` | §10.1 · LOG 1a | Missing or unrecognised input. A user who picked no country is not a flow failure. |
| `Unauthorised` | §10.2 · LOG 1b | `ActionedBy` is not a local admin for the requested country. |
| `Blocked` | §10.2b · LOG 1c | An earlier export for the same country is still running. |
| `No data` | §10.6, §11.7a, §14.1 · LOG 1d / 1f / 2 | A successful run that produced no file. **Not an error.** |
| `Queued` | §11.1d · LOG 1e | Async path: the user has been told "we'll email it", the flow is still working. |
| `Completed` | §14.1 · LOG 2 | A file was produced and delivered. |
| `Failed` | §16.2 · LOG 3 | The catch scope ran. |

**Why `Unauthorised` and `Blocked` are their own values** rather than all folding into `Invalid`:
they answer different questions and each has a view. A rejected authorisation attempt is a security
question. A blocked run is an operational one — if it happens often, two admins are working the same
country and the process needs a conversation, not a code change. Both are invisible if they are
filed as "invalid input", which is what a user typing nothing into a picker produces.

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

## The nine write points

```
Trigger · Initialize variables · canonicalise · compose file name
  ▸ LOG 1   Create item                       Running          §8
Scope - Main
  ├ Validate inputs
  │   ▸ LOG 1a  Update log item invalid       Invalid          §10.1   → Respond → Terminate
  ├ Check authorisation
  │   ▸ LOG 1b  Update log item unauthorised  Unauthorised     §10.2   → Respond → Terminate
  ├ Claim concurrency
  │   ▸ LOG 1c  Update log item claim         Blocked          §10.2b  → Respond → Terminate
  ├ Probe
  │   ▸ LOG 1d  Update log item no data       No data          §10.6   → Respond → Terminate
  ├ Async branch
  │   ▸ LOG 1e  Update log item queued        Queued           §11.1d  → Respond, run continues
  ├ Build · assert · stamp
  │   ▸ LOG 1f  Update log item nothing written  No data       §11.7a  → Respond → Terminate
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
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | *leave empty* |
| DurationSeconds | `0` |
| Rows_Exported | `0` |
| Rows_Skipped | `0` |
| Rows_Stamped | `0` |
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
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `0` |
| Rows_Skipped | `0` |
| Rows_Stamped | `0` |
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
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `0` |
| Rows_Skipped | `0` |
| Rows_Stamped | `0` |
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

# LOG 1c — claim rejected · §10.2b

**Condition:** `greater(length(body('Claim_concurrency')?['value']), 0)`, inside
`equals(variables('varExportType'),'Requests')`.

### `Set varStatus claim rejected`

```
Blocked
```

### `Set varMessage claim rejected`

```
concat('An export for ', variables('varCountry'), ' is already running — started at ',
       formatDateTime(first(body('Claim_concurrency')?['value'])?['Created'],'HH:mm'),
       ' UTC by ', first(body('Claim_concurrency')?['value'])?['ActionedBy_email'],
       '. Wait for it to finish, then try again.')
```

`first(…)` is safe here because the branch only runs when the array is non-empty. The `Get items`
that feeds it must **not** use `Limit Columns by View`, or `Created` and `ActionedBy_email` come
back blank and the message reads "started at  UTC by ".

### `Update log item claim` — inside `Has log item claim`

| Field | Value |
|---|---|
| Id | `@{variables('varLogItemId')}` |
| Title | `BLOCKED · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · Requests` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `Blocked` |
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `0` |
| Rows_Skipped | `0` |
| Rows_Stamped | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `None` |
| ExportFile Url | *leave empty* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{concat('Deferred to run ', first(body('Claim_concurrency')?['value'])?['RunId'], ' (log item ', first(body('Claim_concurrency')?['value'])?['ID'], '), started ', first(body('Claim_concurrency')?['value'])?['Created'], ' by ', first(body('Claim_concurrency')?['value'])?['ActionedBy_email'], '.')}` |
| ErrorMessage | *leave empty* |

**`Notes` names the run it deferred to.** That is what makes a `Blocked` row useful six weeks later:
you can follow it to the export that did go out, and confirm the requests were handed over once
rather than not at all.

### `Respond claim rejected`

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `Blocked` |
| message | `@{variables('varMessage')}` | "An export for Romania is already running — started at 14:07 UTC by …" |
| fileUrl | `@{variables('varDownloadUrl')}` | empty |
| shareUrl | `@{variables('varShareUrl')}` | empty |
| rows | `variables('varRowsExported')` | `0` |

### `Set varResponded claim` → `true` · `Terminate claim rejected` → **Cancelled**

---

# LOG 1d — no data · §10.6

**Condition:** the FALSE branch of `greater(outputs('Compose_probe_count'), 0)`.

### `Set varMessage inventory none` *(Inventory branch)*

```
concat('No SIMs found for ', variables('varCountry'), '.')
```

### `Set varMessage requests none` *(Requests branch, after the diagnostic queries)*

```
if(equals(length(body('Get_requests_diagnostic')?['value']),0),
   concat('No approved requests for ', variables('varCountry'), '.'),
if(equals(length(body('Filter_array_exported')),length(body('Get_requests_diagnostic')?['value'])),
   concat('All ', length(body('Get_requests_diagnostic')?['value']), ' approved requests for ', variables('varCountry'), ' were already sent to the provider. Use Re-export if the provider needs the file again.'),
if(equals(length(body('Filter_array_delegate')),length(body('Get_requests_diagnostic')?['value'])),
   concat(length(body('Filter_array_delegate')), ' approved requests for ', variables('varCountry'), ', none require provider action.'),
   concat('Nothing new to send for ', variables('varCountry'), ' — ', length(body('Filter_array_exported')), ' already sent, ', length(body('Filter_array_delegate')), ' are Delegate.'))))
```

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
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `0` |
| Rows_Skipped | `0` |
| Rows_Stamped | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `None` |
| ExportFile Url | *leave empty* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{variables('varMessage')}` |
| ErrorMessage | *leave empty* |

`Notes` gets the same text the user saw, which is exactly the diagnostic you want — "all 12 already
sent" and "none require provider action" are different situations with the same row count.

### `Respond no data`

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `No data` |
| message | `@{variables('varMessage')}` | one of the four diagnostic sentences |
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
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | ***leave empty*** — the run is still going |
| DurationSeconds | `0` |
| Rows_Exported | `0` |
| Rows_Skipped | `0` |
| Rows_Stamped | `0` |
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

# LOG 1f — nothing written · §11.7a

Requests only. The probe found rows, a file was created, and the script routed **every** one of them
to `skipped`. The workbook now contains nothing but the Instructions sheet, because finalize deleted
every empty tab.

**Condition:** `and(equals(variables('varExportType'),'Requests'), equals(variables('varRowsExported'), 0))`

### `Set varStatus nothing written`

```
No data
```

### `Set varMessage nothing written`

```
concat('Nothing could be sent for ', variables('varCountry'), '. All ',
       variables('varRowsSkipped'), ' approved request(s) were rejected before handover. ',
       variables('varNotes'))
```

`varNotes` already holds the RequestIDs and reasons from §11.7, so the admin gets "1201 unmapped:
Upgrade device, 1355 missing: phoneNr,newPlan" without opening the log.

### Also on this path, before the log write

`Delete empty export file` → `Set varFileCreated false` → `Set varFileUrl empty`. The file must be
gone *and* the variable cleared, or the table below writes a link to a file that no longer exists.

### `Update log item nothing written` — inside `Has log item nothing written`

| Field | Value |
|---|---|
| Id | `@{variables('varLogItemId')}` |
| Title | `NO DATA · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} UTC · @{variables('varCountry')} · Requests · all @{variables('varRowsSkipped')} rejected` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{variables('varExportType')}` |
| Country | `@{variables('varCountry')}` |
| ActionedBy_email | `@{variables('varActionedBy')}` |
| Status | `No data` |
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `0` |
| Rows_Skipped | `@{variables('varRowsSkipped')}` |
| Rows_Stamped | `0` |
| Sheet_Breakdown | *leave empty* |
| Delivery | `None` |
| ExportFile Url | *leave empty — the file was deleted* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{variables('varNotes')}` |
| ErrorMessage | *leave empty* |

**`Rows_Skipped` is the field that matters here**, and it is why the column exists. This row appears
in the "Needs admin action" view, the requests stay unstamped, and the next export picks them up once
the data is fixed.

### `Respond nothing written`

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `No data` |
| message | `@{variables('varMessage')}` | "Nothing could be sent for Romania. All 6 approved request(s) were rejected…" |
| fileUrl | `@{variables('varDownloadUrl')}` | empty |
| shareUrl | `@{variables('varShareUrl')}` | empty |
| rows | `variables('varRowsExported')` | `0` |

### `Set varResponded nothing written` → `true` · `Terminate nothing written` → **Succeeded**

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
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `@{variables('varRowsExported')}` |
| Rows_Skipped | `@{variables('varRowsSkipped')}` |
| Rows_Stamped | `@{variables('varStampedCount')}` |
| Sheet_Breakdown | `@{variables('varSheetBreakdown')}` |
| Delivery | `@{if(equals(variables('varRowsExported'),0),'None',if(variables('varAsync'),'Emailed','Link returned'))}` |
| ExportFile Url | `@{variables('varFileUrl')}` |
| ExportFile Description | `@{variables('varFileName')}` |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{variables('varNotes')}` |
| ErrorMessage | *leave empty* |

**`Delivery` comes from `varAsync`, not from a row count.** The async decision was made on the
*probe count*; rows written is lower after Delegate and skipped rows come out. A probe of 2,100 that
writes 1,950 would log "Link returned" for a run that emailed — misreporting exactly at the boundary
the field exists to help you tune.

**`DurationSeconds` measures to here**, which on the async path is after the email. That is the
number you want: it is how long the work actually took.

`varShareUrl` goes to the email and the response, not to the log — the sharing link is a delivery
artefact, and `{Link}` is the stable address of the file itself.

### `Respond ready` — sync path only, §14

| Output | Value | Resolves to |
|---|---|---|
| status | `@{variables('varStatus')}` | `Completed` |
| message | `@{variables('varMessage')}` | "Export ready: 47 rows. New SIM: 40 · Terminate: 7" |
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
| ReExport | `@{variables('varReExport')}` |
| Started | `@{variables('varStartedUtc')}` |
| Finished | `@{utcNow()}` |
| DurationSeconds | `@{div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)}` |
| Rows_Exported | `@{variables('varRowsExported')}` |
| Rows_Skipped | `@{variables('varRowsSkipped')}` |
| Rows_Stamped | `@{variables('varStampedCount')}` |
| Sheet_Breakdown | `@{variables('varSheetBreakdown')}` |
| Delivery | `None` |
| ExportFile Url | *leave empty — the partial file is deleted* |
| ExportFile Description | *leave empty* |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |
| Notes | `@{variables('varNotes')}` |
| ErrorMessage | `@{outputs('Compose_error_detail')}` |

**The counters keep whatever they reached before the failure.** That is how far the run got, and it
is the number that tells you whether anything was written. `Rows_Stamped` in particular: a non-zero
value on a `Failed` row means §16.6's compensation had work to do — and `Notes` will say whether it
succeeded.

**`ErrorMessage` is the extracted failure, not `string(result('Scope_-_Main'))`.** `result()` returns
every action's result including the `Get items` bodies — tens of megabytes of JSON on a 60,000-row
export, pushed into a multi-line text field with a 63,999-character limit. It fails the update or
fills the column with an unreadable wall.

### `Set varMessage failed` — set in the catch, before `Respond failed`

```
concat('The export for ', variables('varCountry'), ' failed and no file was produced. Nothing has been sent to a provider, and you can safely run it again. Reference ', variables('varRunId'), '.')
```

"You can safely run it again" is a claim the design earns: the partial file is deleted (§16.5) and
any stamps this run applied are cleared (§16.6). Do not soften it — an admin who does not know
whether a re-run will double-send will call someone instead.

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
| §10.2b already running | `Blocked` | — | — | 0 | Notify · Warning |
| §10.6 nothing to export | `No data` | — | — | 0 | Notify · Warning |
| §11.7a all rejected | `No data` | — | — | 0 | Notify · Warning |
| §11.1 async started | `Queued` | — | — | 0 | Notify · Information |
| §14 ready | `Completed` | ✔ | ✔ | n | `Launch(fileUrl)` |
| §16.3 failed | `Failed` | — | — | 0 or partial | Notify · Error |

```
Switch(gblExport.status,
  "Completed",    Launch(gblExport.fileUrl),
  "Queued",       Notify(gblExport.message, NotificationType.Information),
  "No data",      Notify(gblExport.message, NotificationType.Warning),
  "Blocked",      Notify(gblExport.message, NotificationType.Warning),
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
| **Blocked** | `Status = Blocked` | Two admins working the same country. Frequent hits are a process conversation, not a bug. |
| **Needs admin action** | `Rows_Skipped > 0` | Requests that were approved but not sent. They sit unstamped and reappear until someone fixes the data. |
| **Re-exports** | `ReExport = Yes` | Every deliberate re-send of already-handed-over requests, with who and when. |
| **Stamp mismatches** | `Rows_Stamped ≠ Rows_Exported` AND `ExportType = Requests` | Should never have rows. If it does, §12 or §16.6 did something unexpected. |
| **By country, last 30 days** | grouped on Country, `Started >= [Today]-30` | Volume per market, and the double-handover detector of last resort. |
| **Threshold tuning** | `Status = Completed`, showing Rows_Exported and DurationSeconds, sorted by rows | Answers `00`'s open item O6 with data instead of a guess. |

Default view sorted by `Started` descending, showing Status, Country, ExportType, Rows_Exported,
Rows_Skipped, Delivery, ActionedBy_email, ExportFile. Keep `Notes` and `ErrorMessage` out of list
views — several hundred characters destroys the layout, and they read fine in the item form.

---

## Alerting — because nobody watches a list

The catch scope logs and responds, but a log with nobody reading it prevents nothing.

Build a **second, scheduled flow** — not an email inside the catch. Once each weekday morning it
runs three queries against this list and mails a digest to `simri_SupportEmail`:

| Query | Why |
|---|---|
| `Status eq 'Failed' and Started gt '<yesterday>'` | the obvious one |
| `(Status eq 'Running' or Status eq 'Queued') and Started lt '<yesterday>'` | the runs that reached neither terminal action — an email inside the catch **cannot** catch these, because the catch never ran |
| `Rows_Skipped gt 0 and Started gt '<last 7 days>'` | approved requests that are not reaching providers |

Send "nothing to report" on a clean day too. A digest that only arrives when something is wrong is
indistinguishable from a digest that has stopped working.

---

## Retention

The log itself: keep it. At a few runs a day it stays small for years, and it is the audit trail. If
it ever needs trimming, delete `Status = Completed` items older than two years and leave every
failure, rejection, block and re-export intact — those are the ones anyone comes back to.

The **files** the log points at are a different question, and a more urgent one: they contain
employee names, GDIDs and delivery addresses. `/SIM Exports/Files` gets a 90-day retention policy —
see `09_Compliance_and_Data_Protection.md` §2. Once files expire, `ExportFile` links 404 while the
log row remains, which is correct and worth knowing before someone reports it as a bug.
