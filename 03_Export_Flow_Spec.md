# SIM Exports — build spec

One flow, two export types, three delivery outcomes.

**Environment**

| | |
|---|---|
| Site | `https://deutschebank.sharepoint.com/sites/simri` |
| Inventory list | Global SIM Inventory · `6b659861-abd0-4e45-b74e-63e3f69f2648` |
| Order list | Global Order List · `e390b86b-13bb-4655-b3e6-efd5bd068279` |
| Inventory template | `/Documents/SIM_Data_Validation_DEMO.xlsx` |
| Requests template | `/Documents/SIM_Request_Handover_TEMPLATE.xlsx` *(to build)* |
| Output library | `/SIM Exports/Files` |
| Log list | SIM Export Log — see `02_Export_Log.md` |

**Naming.** Power Automate turns spaces into underscores in expressions: an action named
`Get inventory` is `body('Get_inventory')`. Use these names exactly.

---

## 0. Prerequisites

**Index the filter columns.** On Global SIM Inventory: `SIM_Country`. On Global Order List: the
country column and the status column. Without indexes, a filtered `Get items` fails past 5,000
items with the list view threshold error.

**Create `/SIM Exports/Files`** as a document library. Grant read to whoever will click the
download link — this is the single most common cause of "the link doesn't work for me".

**Trigger concurrency: leave OFF.** Unlike the import, exports are read-only, so two people
exporting at once is harmless. Concurrency `1` would queue them for no benefit.

---

## 1. Trigger — PowerApps (V2)

| Input | Type | Name | Reference |
|---|---|---|---|
| Text | Text | `Country` | `triggerBody()?['text']` |
| Text | Text | `ExportType` | `triggerBody()?['text_1']` |
| Text | Text | `ActionedBy` | `triggerBody()?['text_2']` |

`ExportType` is `Inventory` or `Requests`. Confirm the suffixes from your first run — they follow
input order.

---

## 2. Initialize variables

Root level only.

| Name | Type | Initial |
|---|---|---|
| `varRunId` | String | `guid()` |
| `varStartedUtc` | String | `utcNow()` |
| `varFileName` | String | *(empty — set per branch)* |
| `varFileUrl` | String | *(empty)* |
| `varDownloadUrl` | String | *(empty)* |
| `varRowsExported` | Integer | `0` |
| `varSheetBreakdown` | String | *(empty)* |
| `varMessage` | String | *(empty)* |
| `varStatus` | String | `Running` |
| `varLogItemId` | Integer | `0` |
| `varPage` | Integer | `0` |
| `varHasMore` | Boolean | `true` |

### 2a. `Compose Flow Identity`

```
concat('https://make.powerautomate.com/environments/<envId>/flows/', workflow()?['name'], '/runs/', workflow()?['run']?['name'])
```

### 2b. `Compose file name`

```
concat(formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd_HH-mm-ss'),'_',replace(triggerBody()?['text'],' ','-'),'_',triggerBody()?['text_1'],'_',substring(variables('varRunId'),0,8),'.xlsx')
```

Then `Set varFileName` from it. The RunId slice makes filename collisions impossible; the
`replace` handles countries with spaces.

---

## 3. LOG 1 — Create item · `Running`

Per `02_Export_Log.md`. Then `Set varLogItemId` = `body('Create_log_item')?['ID']`.

On the **next** action set *Configure run after* to include **has failed** and **is skipped** — a
logging hiccup must not block an export.

---

## 4. Scope - Main

### 4a. `Validate inputs` — Condition

```
or(empty(triggerBody()?['text']),
   empty(triggerBody()?['text_2']),
   not(or(equals(triggerBody()?['text_1'],'Inventory'), equals(triggerBody()?['text_1'],'Requests'))))
```

**If yes** → `Set varMessage` to what's missing → `Respond to a PowerApp` with
`status = Failed` → `Terminate` (Failed).

Respond **before** terminating, or PowerApps waits until it times out and the user sees nothing.

### 4b. The probe — one call that answers two questions

This is what makes the fast path fast.

**`Get items (probe)`** — SharePoint Get items

| Field | Inventory | Requests |
|---|---|---|
| List | Global SIM Inventory | Global Order List |
| Filter Query | `SIM_Country eq '@{replace(triggerBody()?['text'],'''','''''')}'` | `<CountryCol> eq '…' and <StatusCol> eq 'Approved'` |
| Top Count | `2001` | `2001` |
| Pagination | **OFF** | **OFF** |
| Limit Columns by View | a view with only the columns you export | same |

Use a `Switch` on `ExportType` with a Get items in each case, or one Get items whose list is set
by an expression — the Switch is clearer to debug.

**`Compose probe count`** — `length(body('Get_items_probe')?['value'])`

Fetching `threshold + 1` answers "is this big?" **and** returns the whole dataset when it isn't.
Under the threshold, that one call is the only read the flow makes. Over it, you've spent one
cheap call to learn you need the paged path — and nobody is waiting by then, because the response
has already gone back to the app.

### 4c. `No data` — Condition on `equals(outputs('Compose_probe_count'), 0)`

**If yes:**

- `Set varStatus` = `No data`
- `Set varMessage` = per export type:
  - Inventory — `concat('No SIMs found for ', triggerBody()?['text'], '.')`
  - Requests — `concat('No approved requests for ', triggerBody()?['text'], '.')`
- **No file is created.** An empty workbook sent to a provider is worse than nothing.
- Jump to §6 (log) and §7 (respond)

Two refinements worth adding once the basics work, both from `01_Edge_Cases.md`:

- Approved requests exist but all are internal types (Delegate) → *"3 approved requests, none require provider action."*
- Distinguishing that from a genuine zero matters to the admin, and the two messages read very differently.

### 4d. Size branch — Condition on `lessOrEquals(outputs('Compose_probe_count'), 2000)`

#### YES — synchronous path

1. Build the file from `body('Get_items_probe')?['value']` — §5
2. `Set varStatus` = `Completed`
3. LOG 2 — §6
4. `Respond to a PowerApp` with the URL — §7

#### NO — asynchronous path

1. `Set varStatus` = `Queued`
2. `Set varMessage` = `concat('Export of ', outputs('Compose_probe_count'), '+ rows started. You will receive an email when it is ready.')`
3. **`Respond to a PowerApp` immediately** — the app unblocks here and the user carries on
4. `Get items (full)` — same filter, Top Count `5000`, **Pagination ON**, threshold `100000`
5. Build the file — §5
6. `Set varStatus` = `Completed`
7. LOG 2
8. **Send an email with the link** — see the warning in §7

`Respond to a PowerApp` returns values and the flow keeps running. That is what makes this
pattern work: the user is told "on its way" in about four seconds, and a 60,000-row export takes
as long as it takes without any timeout.

---

## 5. Building the file

### 5a. Common — copy the template

**`Get template`** — SharePoint Get file content

| ExportType | File |
|---|---|
| Inventory | `/Documents/SIM_Data_Validation_DEMO.xlsx` |
| Requests | `/Documents/SIM_Request_Handover_TEMPLATE.xlsx` |

Retry: Exponential, 4. If the template is missing, fail with a message naming the file — a raw
connector 404 tells the admin nothing.

**`Create export file`** — SharePoint Create file · `/SIM Exports/Files` · `varFileName` ·
content from `Get template`.

### 5b. Inventory branch

Reuse what already works. `Shape inventory` (Select) → `Do until pages` → **Run script
`CopyRowsIntoTable`** — the script already in production for the import-side export, unchanged.

Payload per the existing contract: `tableName: Table_query`, `columnsCsv` naming the 20 data
columns, `spareRows: 200`, `repairFormulas: true`.

**Rows are written, formulas and validation come from the template.** Nothing new to build here.

### 5c. Requests branch — `BuildRequestSheets`

A new Office Script. Contract:

**In** — one JSON payload:

```json
{
  "country": "Romania",
  "runId": "…",
  "exportedUtc": "2026-08-13T14:22:00Z",
  "requests": [ { …one object per Order List item… } ],
  "typeMap": [
    { "type": "New SIM",     "sheet": "New SIM",     "fill": ["PhoneNr","ICC_ID","StartDate"] },
    { "type": "Terminate",   "sheet": "Terminate",   "fill": ["TerminationDate"] },
    { "type": "Swap",        "sheet": "Swap",        "fill": ["ICC_ID","EffectiveDate"] },
    { "type": "Transfer",    "sheet": "Transfer",    "fill": ["EffectiveDate"] },
    { "type": "Change plan", "sheet": "Change plan", "fill": ["EffectiveDate"] }
  ]
}
```

**Out** — a JSON string, as with the import script (dynamic keys can't be schema'd):

```json
{ "rowsWritten": 16, "breakdown": [{"sheet":"New SIM","rows":12}], "unmapped": 0, "needsAttention": 0 }
```

**What it does:**

1. Writes each request to the tab for its type
2. Leaves the fill-in columns empty and **unlocked**; every other cell stays locked
3. Protects each sheet (no password) so only fill-in columns accept typing
4. Deletes tabs that ended up with no rows — a provider opening five tabs where two have data assumes the empty ones are a mistake
5. Routes unknown request types to an `Unmapped` tab rather than dropping them
6. Routes rows missing mandatory data to `Needs attention` — the provider never sees a half-formed request
7. Writes RunId, country, export timestamp and row count to a hidden `_Meta` sheet

`_Meta` costs nothing now and is what lets the return-leg import tell a current file from a stale
one. Retrofitting it means asking providers to adopt a new format.

> **Blocked on:** the Order List column schema, and the exact choice values of the request-type
> column. `typeMap` above is a placeholder shaped from your confirmation of the fill-in columns.

### 5d. Build the URLs

**`Compose file url`**

```
concat('https://deutschebank.sharepoint.com/sites/simri/SIM%20Exports/Files/', replace(variables('varFileName'),' ','%20'))
```

**`Compose download url`**

```
concat('https://deutschebank.sharepoint.com/sites/simri/_layouts/15/download.aspx?SourceUrl=', encodeUriComponent(outputs('Compose_file_url')))
```

`download.aspx` forces a download rather than opening in Excel Online — right for a file the user
is about to edit and forward. `encodeUriComponent` on the source path is not optional: without
it, any space or apostrophe breaks the link.

Set `varFileUrl` and `varDownloadUrl` from these.

---

## 6. LOG 2 — Update item

Last action **inside** `Scope - Main`. Full field list in `02_Export_Log.md`. Repopulate every
field — `Update item` writes the whole item and blanks anything left empty.

`Status` = `varStatus` (`Completed` or `No data`).

---

## 7. Responding and delivering

### Sync path — `Respond to a PowerApp or flow`

| Output | Type | Value |
|---|---|---|
| `status` | Text | `@{variables('varStatus')}` |
| `message` | Text | `@{variables('varMessage')}` |
| `fileUrl` | Text | `@{variables('varDownloadUrl')}` |
| `rows` | Number | `@{variables('varRowsExported')}` |

In PowerApps:

```
Set(gblExport, SIMExports.Run(drpCountry.Selected.Value, "Requests", User().Email));
If(gblExport.status = "Completed",
     Launch(gblExport.fileUrl),
   gblExport.status = "Queued",
     Notify(gblExport.message, NotificationType.Information),
   // NoData or Failed
     Notify(gblExport.message, NotificationType.Warning)
)
```

Also show `gblExport.fileUrl` somewhere selectable as a label. If the browser blocks the popup
from `Launch()`, nothing happens and the user has no idea why — a visible link is the fallback.

### Async path — email

⚠️ **Send a link, never an attachment.** A 60,000-row inventory workbook is around 28 MB, and
Outlook caps attachments near 25 MB. The email is a link to `/SIM Exports/Files`, styled like the
import emails in `../SIM Inventory/Email_Templates.md`.

Subject: `Your @{triggerBody()?['text']} @{triggerBody()?['text_1']} export is ready — @{variables('varRowsExported')} rows`

---

## 8. Scope - Catch

Configure run after `Scope - Main` → **has failed**, **is skipped**, **has timed out**.

1. LOG 3 — Update item · `Status = Failed`, `ErrorMessage = @{string(result('Scope_-_Main'))}`
2. **`Respond to a PowerApp`** with `status = Failed` and a readable message — do this *before*
   terminating, or the app hangs until it times out
3. `Delete file` — if `varFileName` was created but the run failed, remove the partial file so a
   half-written workbook can't be found and sent to a provider. Guard with
   `not(empty(variables('varFileName')))`
4. `Terminate` · Failed

Point 3 is the one people skip. A partial export sitting in the library looks exactly like a good
one.

---

## What runs when

| Path | Reads | File | Response | Typical |
|---|---|---|---|---|
| No data | 1 probe | none | immediate | < 3s |
| Sync (≤ 2000 rows) | 1 probe | built from probe | immediate, with URL | 5–20s |
| Async (> 2000) | 1 probe + paged fetch | built after responding | immediate, "we'll email it" | 4s to respond, minutes to deliver |

The threshold is a `Compose` at the top of the flow, not a literal buried in a condition — you
will want to move it after seeing real timings. The `Delivery` column in the log tells you which
way runs are actually going.

---

## Still needed

1. **Global Order List schema** — `_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$select=Title,InternalName,TypeAsString,Required&$filter=Hidden eq false and ReadOnlyField eq false`
2. **The request-type column's name and exact choice values** — they become the tab names
3. **Which column holds the country** on the Order List — same as `SIM_Country`, or different
4. Confirmation of the fill-in columns per type, beyond the four already agreed
