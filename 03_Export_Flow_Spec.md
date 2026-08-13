# SIM Exports — build spec

Written in build order. **Every action is defined before anything references it.** If an
expression mentions `outputs('X')` or `body('X')`, action `X` appears earlier in this document.

**Environment**

| | |
|---|---|
| Site | `https://deutschebank.sharepoint.com/sites/simri` |
| Inventory list | Global SIM Inventory · `6b659861-abd0-4e45-b74e-63e3f69f2648` |
| Order list | Global Order List · `e390b86b-13bb-4655-b3e6-efd5bd068279` |
| Inventory template | `/Documents/SIM_Data_Validation_DEMO.xlsx` |
| Requests template | `/Documents/SIM_Request_Handover_TEMPLATE.xlsx` *(to build)* |
| Output library | `/SIM Exports/Files` |
| Log list | SIM Export Log — schema in `02_Export_Log.md` |
| Order List schema | `04_Order_List_Schema.md` |

**Two naming rules.** Power Automate replaces spaces with underscores in expressions, so
`Get inventory probe` is `body('Get_inventory_probe')`. And no parentheses or punctuation in
action names — they end up in the reference and are easy to mistype.

**Nothing is inherited from the import flow.** This is built from scratch; every action it needs
is listed below.

---

## Action inventory

The complete build, in order. Names are exact.

### Root level

| # | Action | Type |
|---|---|---|
| 1 | *(trigger)* | PowerApps V2 |
| 2 | `Initialize varRunId` … `Initialize varChunkOffset` | Initialize variable × 13 |
| 3 | `Compose Flow Identity` | Compose |
| 4 | `Compose threshold` | Compose |
| 5 | `Compose file name` | Compose |
| 6 | `Set varFileName` | Set variable |
| 7 | `Create log item` | SharePoint Create item |
| 8 | `Set varLogItemId` | Set variable |
| 9 | `Scope - Main` | Scope |
| 10 | `Scope - Catch` | Scope |

### Inside `Scope - Main`

| # | Action | Type |
|---|---|---|
| 9.1 | `Validate inputs` | Condition |
| 9.2 | `Switch source` | Switch |
| 9.3 | `Compose probe count` | Compose |
| 9.4 | `Has data` | Condition |
| 9.5 | `Update log item` | SharePoint Update item |

### Inside `Scope - Catch`

| # | Action | Type |
|---|---|---|
| 10.1 | `Update log item failed` | SharePoint Update item |
| 10.2 | `Respond failed` | Respond to a PowerApp |
| 10.3 | `Delete partial file` | SharePoint Delete file |
| 10.4 | `Terminate failed` | Terminate |

---

## 0. Prerequisites

**Index the filter columns.** Global SIM Inventory: `SIM_Country`. Global Order List:
`CountryName` and `OrderStatus`. Without indexes a filtered `Get items` fails past 5,000 items
with the list view threshold error.

**Create `/SIM Exports/Files`** as a document library and grant read to everyone who will click
a download link. Missing read access is the most common cause of "the link doesn't work for me",
and it surfaces as a browser error the app cannot catch.

**Leave trigger concurrency OFF.** Exports are read-only, so simultaneous runs are harmless.

---

## 1. Trigger — PowerApps (V2)

| Input | Type | Name | Reference |
|---|---|---|---|
| Text | Text | `Country` | `triggerBody()?['text']` |
| Text | Text | `ExportType` | `triggerBody()?['text_1']` |
| Text | Text | `ActionedBy` | `triggerBody()?['text_2']` |

`ExportType` is `Inventory` or `Requests`. Confirm the suffixes from the first run — they follow
input order, and getting them crossed is the most likely early mistake.

---

## 2. Initialize variables

Root level only — Power Automate rejects `Initialize variable` inside a Scope or loop.

| Name | Type | Initial value |
|---|---|---|
| `varRunId` | String | `guid()` |
| `varStartedUtc` | String | `utcNow()` |
| `varFileName` | String | *(empty)* |
| `varFileUrl` | String | *(empty)* |
| `varDownloadUrl` | String | *(empty)* |
| `varRowsExported` | Integer | `0` |
| `varSheetBreakdown` | String | *(empty)* |
| `varMessage` | String | *(empty)* |
| `varStatus` | String | `Running` |
| `varAsync` | Boolean | `false` |
| `varLogItemId` | Integer | `0` |
| `varItems` | Array | `[]` |
| `varChunkOffset` | Integer | `0` |

`varAsync` rather than overloading `varStatus`: the async path needs to remember *how* it
responded long after the status has moved on to `Completed`.

---

## 3. `Compose Flow Identity`

```
concat('https://make.powerautomate.com/environments/<envId>/flows/', workflow()?['name'], '/runs/', workflow()?['run']?['name'])
```

Substitute your environment ID. Used by both log actions.

---

## 4. `Compose threshold`

```
2000
```

The row count at which delivery switches from synchronous to email. Referenced by §9.2 (Top
Count), §9.4 (the size condition) and the log's `Delivery` field — one place to change it once
you have real timings.

---

## 5. `Compose file name`

```
concat(formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd_HH-mm-ss'),'_',replace(triggerBody()?['text'],' ','-'),'_',triggerBody()?['text_1'],'_',substring(variables('varRunId'),0,8),'.xlsx')
```

Produces `2026-08-13_14-22-05_Romania_Requests_a7f3c9e1.xlsx`. The RunId slice makes collisions
impossible; `replace` handles countries with spaces.

## 6. `Set varFileName`

```
outputs('Compose_file_name')
```

---

## 7. `Create log item` — LOG 1

SharePoint **Create item** on SIM Export Log. Field values in `02_Export_Log.md`. Status
`Running`.

Retry: Exponential, 4.

## 8. `Set varLogItemId`

```
body('Create_log_item')?['ID']
```

On `Scope - Main`, set *Configure run after* to include **has failed** and **is skipped** — a
logging hiccup must never block an export.

---

## 9. `Scope - Main`

### 9.1 `Validate inputs` — Condition

```
or(empty(triggerBody()?['text']),
   empty(triggerBody()?['text_2']),
   not(or(equals(triggerBody()?['text_1'],'Inventory'), equals(triggerBody()?['text_1'],'Requests'))))
```

**If true**, in this order:

1. `Set varMessage invalid` — naming what was missing
2. `Set varStatus invalid` — `Failed`
3. `Respond invalid` — Respond to a PowerApp, outputs per §9.4
4. `Terminate invalid` — status `Failed`

Respond **before** terminating or PowerApps waits until it times out and the user sees nothing.

### 9.2 `Switch source`

Switch on `triggerBody()?['text_1']`.

Both `Get items` actions use **Top Count** `@{add(outputs('Compose_threshold'),1)}`,
**Pagination OFF**, and **Limit Columns by View** pointed at a view containing only the exported
columns.

**Case `Inventory`**

| Action | Setting |
|---|---|
| `Get inventory probe` | List: Global SIM Inventory |
| | Filter Query: `SIM_Country eq '@{replace(triggerBody()?['text'],'''','''''')}'` |
| `Set varItems inventory` | `body('Get_inventory_probe')?['value']` |

**Case `Requests`**

| Action | Setting |
|---|---|
| `Get requests probe` | List: Global Order List |
| | Filter Query: `CountryName eq '@{replace(triggerBody()?['text'],'''','''''')}' and OrderStatus eq 'Approved'` |
| `Set varItems requests` | `body('Get_requests_probe')?['value']` |

The `replace(…,'''','''''')` doubles any apostrophe in the country name. Without it
`Côte d'Ivoire` terminates the OData string early and the query fails. It looks like a typo and
isn't.

**Why a Switch rather than one dynamic `Get items`.** The List Name field does accept an
expression, but then Power Automate can't infer the dynamic-content schema, so every downstream
`item()?['ICCID']` loses validation — it stops warning you about a mistyped column name, which on
a list holding both `Requestedby` and `Requestedfor` is precisely when you want the warning. The
filter differs per list anyway, and *Limit Columns by View* is per-list.

**Why both cases converge on `varItems`.** Everything after this is written once. Without the
convergence, `body('Get_inventory_probe')` and `body('Get_requests_probe')` are different
references and the size branch, the empty check, the build, the logging and the response would
each exist twice.

### 9.3 `Compose probe count`

```
length(variables('varItems'))
```

**Why fetch threshold + 1.** It answers "is this big?" *and* returns the whole dataset when it
isn't. Below the threshold this is the only read the flow performs. Above it, one cheap call
bought the knowledge that paging is needed — and by then nobody is waiting, because the response
has already gone back to the app.

### 9.4 `Has data` — Condition

```
greater(outputs('Compose_probe_count'), 0)
```

#### If FALSE — nothing to export

| # | Action | Value |
|---|---|---|
| a | `Set varStatus no data` | `No data` |
| b | `Set varMessage no data` | `@{if(equals(triggerBody()?['text_1'],'Inventory'), concat('No SIMs found for ', triggerBody()?['text'], '.'), concat('No approved requests for ', triggerBody()?['text'], '.'))}` |
| c | `Respond no data` | see outputs below |

**No file is created.** An empty workbook forwarded to a provider is worse than nothing.

#### If TRUE — build and deliver

**9.4.1 `Fits sync` — Condition**

```
lessOrEquals(outputs('Compose_probe_count'), outputs('Compose_threshold'))
```

**If FALSE — the async branch**, in order:

| # | Action | Value |
|---|---|---|
| a | `Set varAsync` | `true` |
| b | `Set varMessage queued` | `@{concat('Export of ', outputs('Compose_probe_count'), '+ rows started. You will receive an email when it is ready.')}` |
| c | `Set varStatus queued` | `Queued` |
| d | `Respond queued` | outputs below — **the app unblocks here** |
| e | `Switch source full` | same two cases as §9.2, but **Top Count 5000, Pagination ON, threshold 100000**, each case ending `Set varItems full` |

`Respond to a PowerApp` returns values and the flow keeps running. That is the whole trick: the
user is told "on its way" in about four seconds and a 60,000-row export then takes as long as it
takes, with no timeout.

**If TRUE** — nothing to do. `varItems` already holds every row from the probe.

**9.4.2 `Switch build`** — Switch on `triggerBody()?['text_1']`

Both cases start the same way:

| Action | Setting |
|---|---|
| `Get template` | SharePoint Get file content — Inventory: `/Documents/SIM_Data_Validation_DEMO.xlsx` · Requests: `/Documents/SIM_Request_Handover_TEMPLATE.xlsx` |
| `Create export file` | SharePoint Create file — Folder `/SIM Exports/Files`, Name `variables('varFileName')`, Content from `Get template` |

**Case `Inventory`** — reuse the proven script

| Action | Setting |
|---|---|
| `Shape inventory` | Select over `variables('varItems')` → the 20 export columns |
| `Do until inventory chunks` | until `varChunkOffset` ≥ `length(body('Shape_inventory'))` |
| ↳ `Run CopyRowsIntoTable` | `tableName: Table_query`, `columnsCsv`, `startRowIndex: varChunkOffset`, `totalExpectedRows: length(body('Shape_inventory'))`, `spareRows: 200`, `repairFormulas: true` |
| ↳ `Increment varChunkOffset` | by the chunk size |
| `Set varRowsExported inventory` | `length(body('Shape_inventory'))` |
| `Set varSheetBreakdown inventory` | `@{concat('Inventory: ', variables('varRowsExported'), ' rows')}` |

`CopyRowsIntoTable` is the script already in production — unchanged.

**Case `Requests`** — new script, see §11

| Action | Setting |
|---|---|
| `Shape requests` | Select over `variables('varItems')` → the allow-listed columns, with `?['Value']` on the three Choice columns and `?['DisplayName']` on `TransferdTo` (see `04_Order_List_Schema.md`) |
| `Run BuildRequestSheets` | payload in §11 |
| `Parse build result` | Parse JSON over `json(body('Run_BuildRequestSheets')?['result'])` |
| `Set varRowsExported requests` | `body('Parse_build_result')?['rowsWritten']` |
| `Set varSheetBreakdown requests` | `body('Parse_build_result')?['breakdownText']` |

**9.4.3 Build the URLs**

| Action | Value |
|---|---|
| `Compose file url` | `concat('https://deutschebank.sharepoint.com/sites/simri/SIM%20Exports/Files/', replace(variables('varFileName'),' ','%20'))` |
| `Compose download url` | `concat('https://deutschebank.sharepoint.com/sites/simri/_layouts/15/download.aspx?SourceUrl=', encodeUriComponent(outputs('Compose_file_url')))` |
| `Set varFileUrl` | `outputs('Compose_file_url')` |
| `Set varDownloadUrl` | `outputs('Compose_download_url')` |
| `Set varStatus completed` | `Completed` |

`download.aspx` forces a download instead of opening in Excel Online — correct for a file the
user is about to edit and forward. `encodeUriComponent` on the source path is required, not
optional: one space or apostrophe breaks the link without it.

**9.4.4 `Was async` — Condition**

```
equals(variables('varAsync'), true)
```

- **If TRUE** → `Send export email` — a **link**, never an attachment. A 60,000-row workbook is
  around 28 MB against Outlook's ~25 MB cap. Style it on the import emails in
  `../SIM Inventory/Email_Templates.md`.
- **If FALSE** → `Respond ready` — outputs below.

Exactly one `Respond to a PowerApp` executes on every path: `Respond invalid`, `Respond no data`,
`Respond queued` or `Respond ready`.

### 9.5 `Update log item` — LOG 2

Last action **inside** `Scope - Main`. Outside it, a failure sending the email would leave the
log claiming `Running` on a run that produced a file. Repopulate every field — SharePoint's
`Update item` writes the whole item and blanks anything left empty. Values in `02_Export_Log.md`.

---

## Respond to a PowerApp — outputs

The same four outputs on all four Respond actions, so PowerApps has one shape to handle.

| Output | Type | Value |
|---|---|---|
| `status` | Text | `@{variables('varStatus')}` |
| `message` | Text | `@{variables('varMessage')}` |
| `fileUrl` | Text | `@{variables('varDownloadUrl')}` |
| `rows` | Number | `@{variables('varRowsExported')}` |

In PowerApps:

```
Set(gblExport, SIMExports.Run(drpCountry.Selected.Value, "Requests", User().Email));
Switch(gblExport.status,
  "Completed", Launch(gblExport.fileUrl),
  "Queued",    Notify(gblExport.message, NotificationType.Information),
  "No data",   Notify(gblExport.message, NotificationType.Warning),
               Notify(gblExport.message, NotificationType.Error)
)
```

Show `gblExport.fileUrl` in a selectable label too. If the browser blocks the popup from
`Launch()`, nothing happens and the user has no way to know why.

---

## 10. `Scope - Catch`

*Configure run after* `Scope - Main` → **has failed**, **is skipped**, **has timed out**.

| # | Action | Detail |
|---|---|---|
| 10.1 | `Update log item failed` | `Status = Failed`, `ErrorMessage = @{string(result('Scope_-_Main'))}` |
| 10.2 | `Respond failed` | `status = Failed`, `message` = something a user can read |
| 10.3 | `Delete partial file` | Only if `not(empty(variables('varFileName')))` — a half-written workbook in the library looks exactly like a good one |
| 10.4 | `Terminate failed` | Status `Failed` |

Respond before terminating. And guard anything referencing an action inside `Scope - Main` — if
the failure happened early, those references are unresolvable and the catch fails too. An error
handler that can fail is not an error handler.

---

## 11. `BuildRequestSheets` — the new Office Script

**Payload in:**

```json
{
  "country": "Romania",
  "runId": "…",
  "exportedUtc": "2026-08-13T14:22:00Z",
  "requests": [ { …one object per Order List item, allow-listed columns only… } ],
  "typeMap": [
    { "type": "New SIM",     "sheet": "New SIM",
      "context": ["SIMType","PlanName","VRCompatible","DeliveryAddress","Location"],
      "fill":    ["PhoneNr","ICCID","StartDate"] },

    { "type": "Terminate",   "sheet": "Terminate",
      "context": ["PhoneNr","ICCID","simInventoryID","PlanName"],
      "fill":    ["EffectiveDate"] },

    { "type": "Swap",        "sheet": "Swap",
      "context": ["PhoneNr","Current ICCID","SIMType","newSimType","simInventoryID","DeliveryAddress"],
      "fill":    ["New ICCID","EffectiveDate"] },

    { "type": "Transfer",    "sheet": "Transfer",
      "context": ["PhoneNr","ICCID","simInventoryID","TransferdTo","PlanName"],
      "fill":    ["EffectiveDate"] },

    { "type": "Change plan", "sheet": "Change plan",
      "context": ["PhoneNr","ICCID","simInventoryID","PlanName","NewPlan"],
      "fill":    ["EffectiveDate"] }
  ]
}
```

Every sheet also carries a protected identity block before the context columns: `RequestID`,
`RequestType`, `GDID`, `Requestedfor`, `Provider`, `Ticket_ID`.

`Delegate` is absent deliberately — internal only, never goes to a provider.

**Returns** a JSON string (dynamic keys can't be schema'd, same as the import script):

```json
{ "rowsWritten": 16, "breakdown": [{"sheet":"New SIM","rows":12}],
  "breakdownText": "New SIM: 12 · Terminate: 3 · Swap: 1",
  "unmapped": 0, "needsAttention": 0 }
```

**What it does:**

1. Writes each request to the tab matching its `RequestType`
2. Leaves fill-in columns empty and **unlocked**; everything else stays locked
3. Protects each sheet with no password, so only the fill-in columns accept typing
4. **Deletes tabs that ended up empty** — a provider seeing five tabs where two have data assumes
   the empty ones are a mistake
5. Routes unknown request types to an `Unmapped` tab rather than dropping them, and counts them
6. Routes rows missing mandatory data to `Needs attention`, so the provider never sees a
   half-formed request
7. Writes RunId, country, export timestamp and row count to a hidden `_Meta` sheet

`_Meta` costs nothing now and is what lets the return-leg import distinguish a current file from
a stale one. Retrofitting it means asking providers to adopt a new format.

---

## Path summary

| Path | Reads | File | Response | Typical |
|---|---|---|---|---|
| Invalid input | 0 | none | immediate | < 2s |
| No data | 1 probe | none | immediate | < 3s |
| Sync ≤ 2000 rows | 1 probe | built from `varItems` | immediate, with URL | 5–20s |
| Async > 2000 rows | 1 probe + paged | built after responding | immediate, "we'll email it" | 4s to respond |

---

## Still needed

1. **The exact `RequestType` choice values** — they become the tab names and the `type` keys in
   `typeMap`. A mismatch sends rows to `Unmapped`.
2. **The `OrderStatus` value meaning approved** — the §9.2 filter assumes `Approved`.
3. **A decision on the missing date column** — four of the five provider-facing types need a date
   back and the list has none. See §3 of `04_Order_List_Schema.md`.

Both choice value sets come from one query:

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$filter=InternalName eq 'RequestType' or InternalName eq 'OrderStatus'&$select=InternalName,Choices
```
