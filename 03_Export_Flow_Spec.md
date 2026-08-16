# SIM Exports — build spec (v2)

Supersedes v1. Rewritten after the review in `05_Review_Findings.md`, with the confirmed answers:
**one provider per country**, **thousands of approved requests per country**, **the admin forwards
the workbook to the provider** (with room for the flow to do it later).

Written in build order. **Every action is defined before anything references it.** If an
expression mentions `outputs('X')` or `body('X')`, action `X` appears earlier in this document.

**Environment**

| | |
|---|---|
| Site | `https://deutschebank.sharepoint.com/sites/simri` |
| Inventory list | Global SIM Inventory · `6b659861-abd0-4e45-b74e-63e3f69f2648` |
| Order list | Global Order List · `e390b86b-13bb-4655-b3e6-efd5bd068279` |
| Inventory template | `/Documents/SIM_Inventory_TEMPLATE.xlsx` — see note below |
| Requests template | `/Documents/SIM_Request_Handover_TEMPLATE.xlsx` — spec in `06_Handover_Template_Spec.md` |
| Output library | `/SIM Exports/Files` |
| Log list | SIM Export Log — schema in `02_Export_Log.md` |
| Order List schema | `04_Order_List_Schema.md` |
| Requests script | `BuildRequestSheets.ts` |

> **Rename the inventory template.** It is currently `SIM_Data_Validation_DEMO.xlsx`. A file with
> `DEMO` in the name is a production dependency of this flow and will eventually be "cleaned up"
> by someone who reads the filename literally. Rename it, update this table, and keep the demo
> copy (with its 33 sample rows) somewhere separate.

**Two naming rules.** Power Automate replaces spaces with underscores in expressions, so
`Get inventory probe` is `body('Get_inventory_probe')`. And no parentheses or punctuation in
action names.

**What changed from v1** — summary for anyone comparing:

| Change | Why |
|---|---|
| `Compose threshold` → `varThreshold` (Integer) | `add`/`greater`/`lessOrEquals` throw on a string |
| Inputs trimmed and canonicalised up front | `empty(' ')` is `false` |
| `Update log item invalid` added | the invalid path left the log on `Running` forever |
| `varResponded` / `varFileCreated` guards | the catch scope could not survive an early failure, or a failure after `Respond queued` |
| One `Get template` + one `Create export file`, outside the Switch | one `body('Create_export_file')` reference instead of two |
| File URL from `{Link}` / `{Path}` | string-built URLs break on library rename and encoding |
| `Create sharing link` | removes the library-permissions dependency |
| One chunked write loop with a completeness assertion | `Do until` silently exits at 60 iterations |
| Requests script chunked | 120-second Office Script timeout |
| Retry `None` on both script actions | a retry after a partial write duplicates rows |
| `RequestType ne 'Delegate'` and `ExportedOn eq null` in the filter | probe count, rows written and log status disagreed |
| §12 `$batch` stamping | prevents double handover without 2,000 `Update item` calls |
| §13 `UploadGate` read | free data-quality report, using machinery the template already has |

---

## 0. Prerequisites

**Order List — two new columns** (see §12 and `04_Order_List_Schema.md`):

| Internal name | Type | Purpose |
|---|---|---|
| `ExportedOn` | Date and Time | Stamped when a request is handed over. Empty = not yet sent. |
| `ExportRunId` | Single line of text | Which export sent it. Matches `_Meta` in the workbook and `RunId` in the log. |
| `EffectiveDate` | Single line of text | Provider fills this for every type except New SIM. |
| `ProviderNotes` | Multiple lines, plain text | Provider free text — "number ported", "address invalid". |

Create them with plain names (no spaces, no underscores) and rename afterwards, then **verify the
internal names** — SharePoint sometimes encodes an underscore as `_x005f_`:

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$select=InternalName,Title&$filter=Hidden eq false
```

**Indexes.** Global SIM Inventory: `SIM_Country`. Global Order List: `CountryName`, `OrderStatus`,
and `ExportedOn`. If a single country can exceed 5,000 rows in the Order List, add a **compound
index** on `CountryName` + `OrderStatus` — the leading filter clause must narrow below 5,000 or
the query is throttled regardless of what follows it.

**Create `/SIM Exports/Files`** as a document library. With §11's sharing link you no longer need
to grant read access to every downstream user, but the *flow's connection* obviously needs write.

**Apply a retention policy** to that library — 90 days is a reasonable default. Every file in it
contains employee names, GDIDs and delivery addresses.

**Leave trigger concurrency OFF.** Turning it on is irreversible in Power Automate. §12.6 uses a
soft claim against the log list instead, which is reversible and visible.

---

## 1. Trigger — PowerApps (V2)

| Input | Type | Name | Reference |
|---|---|---|---|
| Text | Text | `Country` | `triggerBody()?['text']` |
| Text | Text | `ExportType` | `triggerBody()?['text_1']` |
| Text | Text | `ActionedBy` | `triggerBody()?['text_2']` |
| Yes/No | Boolean | `ReExport` | `triggerBody()?['boolean']` |

`ReExport` is optional — §2 coalesces a missing value to `false`. It re-sends requests that were
already stamped, for the genuine case where a provider lost the file.

Confirm the `text_N` suffixes from the first run. They follow input order, and getting them
crossed is the most likely early mistake.

---

## 2. Initialize variables

Root level only — Power Automate rejects `Initialize variable` inside a Scope or loop.

| Name | Type | Initial value |
|---|---|---|
| `varRunId` | String | `guid()` |
| `varStartedUtc` | String | `utcNow()` |
| `varThreshold` | Integer | `2000` |
| `varChunkSize` | Integer | `500` |
| `varBatchSize` | Integer | `100` |
| `varCountry` | String | `trim(coalesce(triggerBody()?['text'],''))` |
| `varExportType` | String | *(empty — set in §3)* |
| `varActionedBy` | String | `trim(coalesce(triggerBody()?['text_2'],''))` |
| `varReExport` | Boolean | `coalesce(triggerBody()?['boolean'], false)` |
| `varFileName` | String | *(empty)* |
| `varFileUrl` | String | *(empty)* |
| `varDownloadUrl` | String | *(empty)* |
| `varShareUrl` | String | *(empty)* |
| `varRowsExported` | Integer | `0` |
| `varSheetBreakdown` | String | *(empty)* |
| `varMessage` | String | *(empty)* |
| `varNotes` | String | *(empty)* |
| `varStatus` | String | `Running` |
| `varAsync` | Boolean | `false` |
| `varResponded` | Boolean | `false` |
| `varFileCreated` | Boolean | `false` |
| `varLogItemId` | Integer | `0` |
| `varItems` | Array | `[]` |
| `varShaped` | Array | `[]` |
| `varChunkOffset` | Integer | `0` |
| `varBuildResult` | String | `{}` |
| `varSkippedIds` | Array | `[]` |
| `varStampUtc` | String | *(empty — set once in §12.2)* |
| `varStampOffset` | Integer | `0` |
| `varStampedCount` | Integer | `0` |
| `varDataErrors` | Integer | `0` |

Three of these carry the weight of the review's findings and are worth understanding:

- **`varThreshold` is an Integer, not a Compose.** A Compose containing `2000` holds the *string*
  `"2000"`, and `add`, `greater` and `lessOrEquals` all throw on a string operand. This was the
  first thing that would have failed.
- **`varResponded`** — exactly one `Respond to a PowerApp` may execute per run. The catch scope
  must know whether one already has.
- **`varFileCreated`** — the catch must not try to delete a file that was never created.

---

## 3. `Set varExportType` — canonicalise and validate in one expression

```
if(equals(toLower(trim(coalesce(triggerBody()?['text_1'],''))),'inventory'),'Inventory',
if(equals(toLower(trim(coalesce(triggerBody()?['text_1'],''))),'requests'),'Requests',
''))
```

An unrecognised value becomes empty, so §9.1's check is simply `empty(variables('varExportType'))`.
A recognised value becomes the canonical casing, so the Switch cases and the log's Choice column
always match — `equals()` and Switch cases are both case-sensitive.

## 4. `Set varChunkSize`

```
if(equals(variables('varExportType'),'Inventory'), 500, 500)
```

Both are 500 today. Keep the `if` so the two can diverge once you have real timings — the
inventory script and the requests script have very different per-row costs.

---

## 5. `Compose Flow Identity`

```
concat('https://make.powerautomate.com/environments/<envId>/flows/', workflow()?['name'], '/runs/', workflow()?['run']?['name'])
```

## 6. `Compose file name`

```
concat(formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd_HH-mm-ss'),'_',replace(variables('varCountry'),' ','-'),'_',variables('varExportType'),'_',substring(variables('varRunId'),0,8),'.xlsx')
```

Produces `2026-08-15_14-22-05_Romania_Requests_a7f3c9e1.xlsx`. Now built from the *trimmed*
country, so a stray space can't produce a filename with a double hyphen.

## 7. `Set varFileName`

```
outputs('Compose_file_name')
```

---

## 8. `Create log item` — LOG 1

SharePoint **Create item** on SIM Export Log. Field values in `02_Export_Log.md`. Status
`Running`. Retry: Exponential, 4.

## 9. `Set varLogItemId`

```
body('Create_log_item')?['ID']
```

*Configure run after* → **has succeeded** only. If §8 failed, this is skipped and `varLogItemId`
stays `0`, which §14.1 checks for.

---

## 10. `Scope - Main`

*Configure run after* `Set varLogItemId` → **has succeeded**, **has failed**, **is skipped**. A
logging hiccup must never block an export.

### 10.1 `Validate inputs` — Condition

```
or(empty(variables('varCountry')),
   empty(variables('varActionedBy')),
   empty(variables('varExportType')))
```

**If true**, in this order:

| # | Action | Value |
|---|---|---|
| a | `Set varStatus invalid` | `Invalid` |
| b | `Set varMessage invalid` | expression below |
| c | `Update log item invalid` | inside a condition on `greater(variables('varLogItemId'),0)` |
| d | `Respond invalid` | outputs per §15 |
| e | `Set varResponded invalid` | `true` |
| f | `Terminate invalid` | status **`Cancelled`** |

```
concat('Cannot export: ',
  if(empty(variables('varCountry')),'no country was supplied. ',''),
  if(empty(variables('varActionedBy')),'no user was supplied. ',''),
  if(empty(variables('varExportType')),concat('export type "',trim(coalesce(triggerBody()?['text_1'],'(blank)')),'" is not Inventory or Requests. '),''))
```

Three things v1 got wrong here, all fixed above:

- **`empty()` does not catch whitespace.** §2 trims before storing, so a country of one space is
  now genuinely empty.
- **The log update.** `Terminate` ends the run immediately — §10.6 never runs, and `Scope - Catch`
  does **not** run after a Terminate either. Without step (c) the log item stays `Running` forever
  and `02`'s "Stuck runs" view fills with people who forgot to pick a country.
- **`Cancelled`, not `Failed`.** A user typing nothing into a picker is not a flow failure, and
  the run-history failure count is something you will want to trust.

### 10.2 `Check authorisation` — optional but recommended

`Get items` on a **Country Admins** list, filter
`Email eq '@{variables('varActionedBy')}' and Country eq '@{replace(variables('varCountry'),'''','''''')}'`,
Top Count 1. If `equals(length(body('Check_authorisation')?['value']),0)` → same six-step shape as
§10.1 with a "not authorised for <country>" message and `Set varStatus unauthorised` = `Invalid`.

**Be honest about what this is.** There is no trustworthy caller identity on a PowerApps V2
trigger — `ActionedBy` is a parameter the caller supplies, and anyone the app is shared with can
call the flow directly with any parameters. This check stops casual misuse and gives you an audit
trail. It is **not** an access control. Record that residual risk rather than implying it's closed.

### 10.3 `Compose requests filter`

```
concat('CountryName eq ''', replace(variables('varCountry'),'''',''''''),
       ''' and OrderStatus eq ''Approved'' and RequestType ne ''Delegate''',
       if(variables('varReExport'), '', ' and ExportedOn eq null'))
```

Three clauses, each earning its place:

- `replace(…,'''','''''')` doubles any apostrophe. Without it `Côte d'Ivoire` terminates the OData
  string early and the query fails. It looks like a typo and isn't.
- `RequestType ne 'Delegate'` — v1 omitted this, so Delegate rows were fetched and counted. The
  probe said "3 rows", the script wrote 0 provider rows, and the log computed `No data` on a run
  that had already created a file and returned a URL to it.
- `ExportedOn eq null` — the double-handover guard (§12), dropped when `ReExport` is set.

`Compose inventory filter`:

```
concat('SIM_Country eq ''', replace(variables('varCountry'),'''',''''''), '''')
```

### 10.4 `Switch source` — the probe

Switch on `variables('varExportType')`. Both `Get items` use **Top Count**
`@{add(variables('varThreshold'),1)}`, **Pagination OFF**, and **Limit Columns by View** pointed at
a view containing only the exported columns.

| Case | Action | Setting |
|---|---|---|
| `Inventory` | `Get inventory probe` | Global SIM Inventory · Filter `@{outputs('Compose_inventory_filter')}` |
| | `Set varItems inventory` | `body('Get_inventory_probe')?['value']` |
| `Requests` | `Get requests probe` | Global Order List · Filter `@{outputs('Compose_requests_filter')}` |
| | `Set varItems requests` | `body('Get_requests_probe')?['value']` |

**Why a Switch rather than one dynamic `Get items`.** The List Name field accepts an expression,
but then Power Automate can't infer the dynamic-content schema and every downstream
`item()?['ICCID']` loses validation — it stops warning about a mistyped column name, which on a
list holding both `Requestedby` and `Requestedfor` is precisely when you want the warning.

**Why both cases converge on `varItems`.** Everything after this is written once.

### 10.5 `Compose probe count`

```
length(variables('varItems'))
```

**Why fetch threshold + 1.** It answers "is this big?" *and* returns the whole dataset when it
isn't. Below the threshold this is the only read the flow performs.

### 10.6 `Has data` — Condition

```
greater(outputs('Compose_probe_count'), 0)
```

#### If FALSE — nothing to export

For Inventory, one message. For Requests, "nothing to export" now has three distinct causes and
the admin needs to know which — so run one diagnostic query before answering.

| # | Action | Detail |
|---|---|---|
| a | `Is requests export` — Condition | `equals(variables('varExportType'),'Requests')` |
| a1 | ↳ `Get requests diagnostic` | Order List, filter `CountryName eq '…' and OrderStatus eq 'Approved'`, Top 5000, columns limited to `RequestType` + `ExportedOn` |
| a2 | ↳ `Filter array delegate` | from `body('Get_requests_diagnostic')?['value']` where `equals(item()?['RequestType']?['Value'],'Delegate')` |
| a3 | ↳ `Filter array exported` | where `not(equals(item()?['ExportedOn'],null))` |
| a4 | ↳ `Set varMessage requests none` | expression below |
| b | `Set varMessage inventory none` *(else branch)* | `concat('No SIMs found for ', variables('varCountry'), '.')` |
| c | `Set varStatus no data` | `No data` |
| d | `Respond no data` | §15 |
| e | `Set varResponded no data` | `true` |

```
if(equals(length(body('Get_requests_diagnostic')?['value']),0),
   concat('No approved requests for ', variables('varCountry'), '.'),
if(equals(length(body('Filter_array_exported')),length(body('Get_requests_diagnostic')?['value'])),
   concat('All ', length(body('Get_requests_diagnostic')?['value']), ' approved requests for ', variables('varCountry'), ' were already sent to the provider. Use Re-export if the provider needs the file again.'),
if(equals(length(body('Filter_array_delegate')),length(body('Get_requests_diagnostic')?['value'])),
   concat(length(body('Filter_array_delegate')), ' approved requests for ', variables('varCountry'), ', none require provider action.'),
   concat('Nothing new to send for ', variables('varCountry'), ' — ', length(body('Filter_array_exported')), ' already sent, ', length(body('Filter_array_delegate')), ' are Delegate.'))))
```

**No file is created.** An empty workbook forwarded to a provider is worse than nothing.

#### If TRUE — build and deliver

Continue to §11.

---

## 11. Build and deliver

### 11.1 `Fits sync` — Condition

```
lessOrEquals(outputs('Compose_probe_count'), variables('varThreshold'))
```

**If FALSE — the async branch**, in order:

| # | Action | Value |
|---|---|---|
| a | `Set varAsync` | `true` |
| b | `Set varMessage queued` | `@{concat('Export of ', outputs('Compose_probe_count'), '+ rows started. You will receive an email when it is ready.')}` |
| c | `Set varStatus queued` | `Queued` |
| d | `Update log item queued` | so a long run doesn't look stuck; guard on `varLogItemId > 0` |
| e | `Respond queued` | §15 — **the app unblocks here** |
| f | `Set varResponded queued` | `true` |
| g | `Switch source full` | same two cases as §10.4, **Top Count 5000, Pagination ON, threshold 100000**, each ending `Set varItems full` |

`Respond to a PowerApp` returns values and the flow keeps running. That is the whole trick: the
user is told "on its way" in about four seconds and a 60,000-row export takes as long as it takes.

**If TRUE** — nothing to do. `varItems` already holds every row from the probe.

### 11.2 `Compose template path`

```
if(equals(variables('varExportType'),'Inventory'),
   '/Documents/SIM_Inventory_TEMPLATE.xlsx',
   '/Documents/SIM_Request_Handover_TEMPLATE.xlsx')
```

### 11.3 `Get template` → `Create export file`

| Action | Setting |
|---|---|
| `Get template` | SharePoint **Get file content using path** · Path `@{outputs('Compose_template_path')}` |
| `Create export file` | SharePoint **Create file** · Folder `/SIM Exports/Files` · Name `@{variables('varFileName')}` · Content `body('Get_template')` |
| `Set varFileCreated` | `true` |
| `Set varFileUrl` | `body('Create_export_file')?['{Link}']` |

v1 duplicated these inside each Switch case, which meant two different action names and therefore
two of every downstream reference. One Compose collapses them into one.

**Take the URL from the connector, never build it.** `{Link}` is the absolute, correctly-encoded
URL. A hand-built path breaks the day someone renames the library, or on any character needing
encoding beyond a space — and a library's *URL* often differs from its *display name*.

### 11.4 `Switch shape` — Switch on `variables('varExportType')`

**Case `Inventory`** — `Shape inventory`, a Select over `variables('varItems')` producing the 20
writable columns of `Table_query`, then `Set varShaped` = `body('Shape_inventory')`.

Note the template's writable columns are **not contiguous**: A–S plus **U (IMEI)**. Column T and
V–AC hold the check formulas (`IsPhoneValid`, `PhoneClean`, `ICC_Check`, `IMEI_Check`,
`Date_Check`, `Status_Check`, `SIMType_Check`, `RowErrors`, `HasError`) and must be left alone —
that is what `repairFormulas: true` is for.

**Case `Requests`** — `Shape requests`, a Select over `variables('varItems')`, then
`Set varShaped` = `body('Shape_requests')`. The map, using the explicit allow-list from
`04_Order_List_Schema.md`:

```json
{
  "requestId":        "@{item()?['ID']}",
  "requestType":      "@{item()?['RequestType']?['Value']}",
  "gdid":             "@{item()?['GDID']}",
  "requestedFor":     "@{item()?['Requestedfor']}",
  "provider":         "@{item()?['Provider']}",
  "ticketId":         "@{item()?['Ticket_ID']}",
  "phoneNr":          "@{item()?['PhoneNr']}",
  "iccid":            "@{item()?['ICCID']}",
  "currentIccid":     "@{item()?['ICCID']}",
  "simType":          "@{item()?['SIMType']?['Value']}",
  "newSimType":       "@{item()?['newSimType']}",
  "planName":         "@{item()?['PlanName']}",
  "newPlan":          "@{item()?['NewPlan']}",
  "vrCompatible":     "@{if(item()?['VRCompatible'],'Yes','No')}",
  "deliveryAddress":  "@{item()?['DeliveryAddress']}",
  "location":         "@{item()?['Location']}",
  "simInventoryId":   "@{item()?['simInventoryID']}",
  "transferdTo":      "@{item()?['TransferdTo']?['DisplayName']}",
  "startDate":        "@{item()?['StartDate']}"
}
```

`?['Value']` on the three Choice columns and `?['DisplayName']` on the User column are not
optional — without them a Choice serialises as an object and lands in the sheet as
`[object Object]`. `VRCompatible` is a real Boolean, so `true`/`false` reaches the provider unless
converted.

`currentIccid` duplicates `iccid` deliberately: the Swap sheet has two ICCID columns and the
script matches payload keys to table headers by name (§16), so `Current ICCID` needs a key of its
own. `New ICCID`, `EffectiveDate` and `ProviderNotes` are absent on purpose — they are the
provider's to fill.

**Allow-list, not "everything except".** A column added to the Order List next year defaults to
*not* being sent, which is the safe direction. `WorkHistory`, `ApprovalPlanJson`, `Justification`
and `LineManager` never leave the building.

### 11.5 `Do until write chunks`

**Condition:** `greaterOrEquals(variables('varChunkOffset'), length(variables('varShaped')))`

**Limits: Count `5000`, Timeout `PT2H`.** This is not optional. The defaults are Count 60 and
Timeout PT1H, and when the count limit is hit the loop **exits normally — it does not fail**. At
60,000 rows and 500 per chunk that is 120 iterations, so the flow would report success, log the
*intended* row count, return a URL, and hand over a workbook missing half its rows. Nothing
anywhere would show an error. It is the highest-consequence defect in v1 precisely because the
resulting file looks perfectly normal.

Inside the loop, in order:

| # | Action | Value |
|---|---|---|
| a | `Compose chunk` | `take(skip(variables('varShaped'), variables('varChunkOffset')), variables('varChunkSize'))` |
| b | `Compose is final chunk` | `lessOrEquals(add(variables('varChunkOffset'), length(outputs('Compose_chunk'))), length(variables('varShaped')))` → see note |
| c | `Switch script` | two cases below |
| d | `Increment varChunkOffset` | `length(outputs('Compose_chunk'))` |

For (b), the final chunk is the one after which the offset reaches the total:

```
greaterOrEquals(add(variables('varChunkOffset'), length(outputs('Compose_chunk'))), length(variables('varShaped')))
```

For (d), increment by the **actual** chunk length, not by `varChunkSize` — otherwise the last,
partial chunk overshoots and the loop's own accounting disagrees with §11.6's assertion.

**`Switch script` — case `Inventory`:**

`Run CopyRowsIntoTable` — `tableName: Table_query`, `columnsCsv`, `rows: outputs('Compose_chunk')`,
`startRowIndex: variables('varChunkOffset')`,
`totalExpectedRows: length(variables('varShaped'))`, `spareRows: 200`, `repairFormulas: true`.
**Retry policy: None.**

**`Switch script` — case `Requests`:**

| Action | Setting |
|---|---|
| `Run BuildRequestSheets` | payload in §16. **Retry policy: None.** |
| `Set varBuildResult` | `body('Run_BuildRequestSheets')?['result']` |
| `Set varSkippedIds` | `union(variables('varSkippedIds'), json(body('Run_BuildRequestSheets')?['result'])?['skippedIds'])` |

**Retry `None` on both, and this matters more than it looks.** Every connector action defaults to
Exponential/4. If a script times out at 120 seconds *after* writing some rows, Power Automate
retries it and the script writes them again. The default retry policy turns a slow chunk into
duplicated data. Keep Exponential/4 on the SharePoint reads and the log writes, where retrying is
safe and useful.

`varBuildResult` is overwritten every iteration; the last write — the finalize chunk — is the one
§11.7 parses. `varSkippedIds` accumulates across chunks with `union`, which also de-duplicates.

### 11.6 `Assert all rows written` — Condition

```
greaterOrEquals(variables('varChunkOffset'), length(variables('varShaped')))
```

**If FALSE**, in order:

| # | Action | Value |
|---|---|---|
| a | `Set varMessage short write` | `@{concat('Export aborted: wrote ', variables('varChunkOffset'), ' of ', length(variables('varShaped')), ' rows. The file was deleted. Re-run the export.')}` |
| b | `Force failure short write` | Compose · input `@{div(1,0)}` |

**On the deliberate division by zero.** Power Automate has no "throw". A `Terminate` here would
skip `Scope - Catch`, so the log would never record the failure and the partial file would stay in
the library looking like a good export. Failing an action inside `Scope - Main` is the only way to
route into the catch, and `div(1,0)` is the standard idiom. Name the action clearly and leave a
comment on it, so nobody "fixes" it six months from now.

### 11.7 `Switch finalize` — Switch on `variables('varExportType')`

**Case `Inventory`:**

| Action | Value |
|---|---|
| `Set varRowsExported inventory` | `length(variables('varShaped'))` |
| `Set varSheetBreakdown inventory` | `@{concat('Inventory: ', length(variables('varShaped')), ' rows')}` |

**Case `Requests`:**

| Action | Value |
|---|---|
| `Parse build result` | Parse JSON over `json(variables('varBuildResult'))`, schema in §16 |
| `Set varRowsExported requests` | `body('Parse_build_result')?['cumulativeRows']` |
| `Set varSheetBreakdown requests` | `body('Parse_build_result')?['breakdownText']` |
| `Set varNotes requests` | expression below |

```
concat(
  if(greater(length(body('Parse_build_result')?['skipped']),0),
     concat(length(body('Parse_build_result')?['skipped']), ' request(s) were NOT sent: ', string(body('Parse_build_result')?['skipped']), ' | '), ''),
  if(greater(length(body('Parse_build_result')?['unfilledHeaders']),0),
     concat('Columns left empty: ', join(body('Parse_build_result')?['unfilledHeaders'], ', '), ' | '), ''),
  'Written: ', body('Parse_build_result')?['breakdownText'])
```

**Unmapped and Needs-attention rows are reported, not shipped.** v1 put them in tabs inside the
workbook the provider receives — a provider opening `Needs attention` either actions those
requests anyway or emails to ask. `01` §4's own goal ("the provider never sees a half-formed
request") is met by keeping them out of the file and putting them here, in the response message,
the email and the log's `Notes`. Silent data loss is still prevented; the provider just isn't the
one told about it.

### 11.8 Delivery URLs

| Action | Value |
|---|---|
| `Create sharing link` | SharePoint · File Identifier `body('Create_export_file')?['{Identifier}']` · Link type **View** · Scope **Organization** |
| `Set varShareUrl` | `body('Create_sharing_link')?['link']?['webUrl']` |
| `Compose download url` | `concat('https://deutschebank.sharepoint.com/sites/simri/_layouts/15/download.aspx?SourceUrl=', encodeUriComponent(body('Create_export_file')?['{Path}']))` |
| `Set varDownloadUrl` | `outputs('Compose_download_url')` |
| `Set varStatus completed` | `Completed` |
| `Set varMessage ready` | `@{concat('Export ready: ', variables('varRowsExported'), ' rows. ', variables('varSheetBreakdown'))}` |

**`Create sharing link` answers the delivery question `00` left open.** The link carries its own
access grant, so library permissions stop mattering — and a permissions gap was the whole reason
`download.aspx` surfaced as an uncatchable browser error. It also works identically on the sync
and async paths, so you maintain one delivery mechanism rather than two.

Scope **Organization**, not Anyone: the file contains employee names and delivery addresses.
Since the admin forwards it to the provider by hand today, an organisation-scoped link is right —
revisit if the flow ever mails the provider directly.

Keep `download.aspx` as the in-app `Launch()` target if you want the forced-download behaviour;
use the sharing link in the email.

**`Set varMessage ready` is new.** In v1 `varMessage` was set on the invalid, no-data and queued
paths but never on success — so `gblExport.message` was empty exactly when the user succeeded.

---

## 12. Stamping — preventing the double handover

Requests only, and only when rows actually reached a provider tab. This is `01` §1, and it is the
only failure in the whole design that costs real money: an approved request exported twice means
a second SIM provisioned and a bill for a line nobody asked for.

**Why stamp rather than transition `OrderStatus`.** A status transition means extending the choice
column and hunting down every view, filter and flow that keys on `Approved` — including ones you
don't own. Two additive columns break nothing, and `ExportRunId` does double duty as the key the
return-leg import needs.

**Why `$batch` rather than `Apply to each`.** `SharePoint — Update item` is one API call per row,
against a connector limit of roughly 600 calls per 60 seconds. Two thousand rows on the
**synchronous** path — where PowerApps gives you 120 seconds total — will not finish. Stamping via
`Apply to each` quietly makes the sync path async, defeating the reason `00` chose a threshold at
all. `$batch` does 100 rows per call: 2,000 rows is 20 calls and a few seconds.

**Stamp after the file is confirmed written, never before.** If the build fails after stamping,
requests are marked exported and were never sent — a worse failure than the one being prevented.
That is why this section sits after §11 and before the response.

### 12.1 `Is stampable` — Condition

```
and(equals(variables('varExportType'),'Requests'), greater(variables('varRowsExported'), 0))
```

Everything below runs inside the TRUE branch.

### 12.2 `Set varStampUtc`

```
utcNow()
```

Set it **once**, here.

Not inside the loop. `utcNow()` in a loop drifts, and every request in one handover should carry
one timestamp — that is what makes "this batch went out together" answerable later.

### 12.3 `Filter array stampable`

From `variables('varShaped')`, advanced condition:

```
@not(contains(variables('varSkippedIds'), item()?['requestId']))
```

Rows the script routed to unmapped or needs-attention were never sent, so they must stay
unstamped and be picked up by the next export.

### 12.4 `Select stamp ids`

From `body('Filter_array_stampable')`, map (text mode): `@{item()?['requestId']}`

### 12.5 `Do until stamp batches`

**Condition:** `greaterOrEquals(variables('varStampOffset'), length(body('Select_stamp_ids')))`
**Limits: Count `5000`, Timeout `PT1H`.**

| # | Action | Value |
|---|---|---|
| a | `Compose stamp chunk` | `take(skip(body('Select_stamp_ids'), variables('varStampOffset')), variables('varBatchSize'))` |
| b | `Compose batch id` | `guid()` |
| c | `Compose changeset id` | `guid()` |
| d | `Select changeset parts` | map below |
| e | `Compose batch body` | below |
| f | `Send stamp batch` | below |
| g | `Check batch response` | Condition — below |
| h | `Increment varStampOffset` | `length(outputs('Compose_stamp_chunk'))` |
| i | `Increment varStampedCount` | `length(outputs('Compose_stamp_chunk'))` |

**(d) `Select changeset parts`** — From `outputs('Compose_stamp_chunk')`, map in **text mode**:

```
@{concat(
'--changeset_', outputs('Compose_changeset_id'), decodeUriComponent('%0D%0A'),
'Content-Type: application/http', decodeUriComponent('%0D%0A'),
'Content-Transfer-Encoding: binary', decodeUriComponent('%0D%0A%0D%0A'),
'PATCH https://deutschebank.sharepoint.com/sites/simri/_api/web/lists(guid''e390b86b-13bb-4655-b3e6-efd5bd068279'')/items(', item(), ') HTTP/1.1', decodeUriComponent('%0D%0A'),
'Content-Type: application/json;odata=nometadata', decodeUriComponent('%0D%0A'),
'Accept: application/json;odata=nometadata', decodeUriComponent('%0D%0A'),
'IF-MATCH: *', decodeUriComponent('%0D%0A%0D%0A'),
'{"ExportedOn":"', variables('varStampUtc'), '","ExportRunId":"', variables('varRunId'), '"}', decodeUriComponent('%0D%0A')
)}
```

`decodeUriComponent('%0D%0A')` is how you get a literal CRLF into a Power Automate expression.
The `$batch` MIME parser is strict about line endings — a bare LF is rejected — and typing a real
newline into the designer is unreliable. This idiom is the reason the expression looks the way it
does.

**(e) `Compose batch body`:**

```
@{concat(
'--batch_', outputs('Compose_batch_id'), decodeUriComponent('%0D%0A'),
'Content-Type: multipart/mixed; boundary="changeset_', outputs('Compose_changeset_id'), '"', decodeUriComponent('%0D%0A%0D%0A'),
join(body('Select_changeset_parts'), ''),
'--changeset_', outputs('Compose_changeset_id'), '--', decodeUriComponent('%0D%0A'),
'--batch_', outputs('Compose_batch_id'), '--', decodeUriComponent('%0D%0A')
)}
```

**(f) `Send stamp batch`** — `Send an HTTP request to SharePoint`:

| | |
|---|---|
| Site Address | `https://deutschebank.sharepoint.com/sites/simri` |
| Method | `POST` |
| Uri | `_api/$batch` |
| Headers | `Content-Type` : `@{concat('multipart/mixed; boundary="batch_', outputs('Compose_batch_id'), '"')}` |
| | `Accept` : `application/json;odata=nometadata` |
| Body | `@{outputs('Compose_batch_body')}` |
| Retry | **None** |

The connector handles the form digest for you. The boundary in the header must match the one in
the body exactly, which is why both come from the same Compose.

**(g) `Check batch response`** — a `$batch` call returns **HTTP 200 even when individual
operations inside it failed**. Without this check, stamping silently does nothing and the double
handover you built all this to prevent happens anyway.

Condition:

```
or(contains(string(body('Send_stamp_batch')), 'HTTP/1.1 4'),
   contains(string(body('Send_stamp_batch')), 'HTTP/1.1 5'))
```

**If true** → `Set varMessage stamp failed` naming the offset, then
`Force failure stamp` (Compose, `@{div(1,0)}`) to route into the catch. A file that was built but
whose rows weren't stamped must not be delivered — the next export would send them again.

### 12.6 Soft concurrency claim — instead of trigger concurrency

`03` v1 said leave trigger concurrency off; `01` §6 said set it to 1 once stamping exists. Both
can't hold: two admins exporting the same country simultaneously both read the same unstamped
rows and both hand them over.

**Turning on trigger concurrency is irreversible** — the designer warns you and means it. It also
queues *inventory* exports behind requests exports, which is a cost you get nothing for.

Instead, add to §10.2: `Get items` on SIM Export Log filtered
`Status eq 'Running' and Country eq '…' and ExportType eq 'Requests' and Created gt '@{addMinutes(utcNow(),-30)}'`,
Top 1. If anything comes back, reject with "an export for Romania is already in progress, started
at …". Reversible, visible in the list, and it names the run rather than silently queueing.

### 12.7 `Set varNotes stamped`

Append to `varNotes`:

```
@{concat(variables('varNotes'), ' | Stamped ', variables('varStampedCount'), ' request(s) with RunId ', variables('varRunId'), if(variables('varReExport'),' (RE-EXPORT)',''))}
```

---

## 13. `Read upload gate` — free data-quality reporting

Inventory only. The template already computes everything needed and the flow currently ignores it.

`Config!J2` is the named range **`UploadGate`**:
`=IF(COUNTIF(Table_query[HasError],"ERROR")=0,"OK","BLOCKED")`, with `UploadGate_ErrorCount` at
`J3`. Because both use structured references over `Table_query`, they cover every written row —
unlike the conditional formatting, which stops at row 1966 (see `06_Handover_Template_Spec.md`).

Add a small Office Script `ReadUploadGate` that returns
`{ "gate": "OK|BLOCKED", "errorCount": n }` as a JSON string, then two actions after §11.6, inside
a condition on `equals(variables('varExportType'),'Inventory')`:

| Action | Setting |
|---|---|
| `Run ReadUploadGate` | Excel Run script · File `body('Create_export_file')?['{Identifier}']` · Retry **None** |
| `Set varDataErrors` | `int(json(body('Run_ReadUploadGate')?['result'])?['errorCount'])` |

Then append to `varNotes` when non-zero:

```
@{concat(variables('varNotes'), ' | ', variables('varDataErrors'), ' exported row(s) fail validation — see the RowErrors column.')}
```

This costs one script call and turns every inventory export into a data-quality audit of that
country's estate, using the Luhn checks, dial-code checks and date checks already built and
tested in the template. Do not *block* on it — the export is a read, and the admin may be
exporting precisely because they want to see the bad rows.

---

## 14. `Was async` — respond or email

```
equals(variables('varAsync'), true)
```

- **If TRUE** → `Send export email` to `variables('varActionedBy')` with `varShareUrl` as a
  **link**, never an attachment. A 60,000-row workbook is around 28 MB against Outlook's ~25 MB
  cap. Style it on the import emails in `../SIM Inventory/Email_Templates.md`. Include
  `varSheetBreakdown` and `varNotes` — the skipped-request list is the part the admin must act on.
- **If FALSE** → `Respond ready` (§15), then `Set varResponded ready` = `true`.

Exactly one `Respond to a PowerApp` executes on every path: `Respond invalid`, `Respond no data`,
`Respond queued` or `Respond ready`.

## 14.1 `Update log item` — LOG 2

Last action **inside** `Scope - Main`, wrapped in a condition on
`greater(variables('varLogItemId'), 0)`. Outside the scope, a failure sending the email would
leave the log claiming `Running` on a run that produced a file.

Repopulate **every** field — SharePoint's `Update item` writes the whole item and blanks anything
left empty. Values in `02_Export_Log.md`, with two corrections from the review:

```
Delivery = @{if(variables('varAsync'),'Emailed','Link returned')}
```

Not `if(greater(varRowsExported, threshold), …)`. The async decision was made on the **probe
count**; rows written is lower after Delegate and skipped rows come out. A probe of 2,100 that
writes 1,950 would have logged "Link returned" for a run that emailed — misreporting exactly at
the boundary the field exists to help you tune.

```
Status = @{if(equals(variables('varRowsExported'),0),'No data',variables('varStatus'))}
```

And two fields that consume variables set earlier but referenced nowhere else in this document —
listed here so the cross-reference is complete:

```
ExportFile Url         = @{variables('varFileUrl')}      — from §11.3, the {Link} value
ExportFile Description = @{variables('varFileName')}
Notes                  = @{variables('varNotes')}        — skipped requests, stamping, data errors
```

`varShareUrl` goes to the email (§14) and the response (§15), not to the log — the sharing link
is a delivery artefact, and `{Link}` is the stable address of the file itself.

---

## 15. Respond to a PowerApp — outputs

The same five outputs on all four Respond actions, so PowerApps has one shape to handle.

| Output | Type | Value |
|---|---|---|
| `status` | Text | `@{variables('varStatus')}` |
| `message` | Text | `@{variables('varMessage')}` |
| `fileUrl` | Text | `@{variables('varDownloadUrl')}` |
| `shareUrl` | Text | `@{variables('varShareUrl')}` |
| `rows` | Number | `variables('varRowsExported')` |

On `rows`, use the bare expression, not `@{…}` — string interpolation coerces the value to text.

In PowerApps:

```
UpdateContext({locBusy: true});
Set(gblExport, SIMExports.Run(
    Trim(drpCountry.Selected.Value), "Requests", User().Email, tglReExport.Value));
UpdateContext({locBusy: false});
Switch(gblExport.status,
  "Completed", Launch(gblExport.fileUrl),
  "Queued",    Notify(gblExport.message, NotificationType.Information),
  "No data",   Notify(gblExport.message, NotificationType.Warning),
  "Invalid",   Notify(gblExport.message, NotificationType.Error),
               Notify(gblExport.message, NotificationType.Error)
)
```

Bind the Export button's `DisplayMode` to `If(locBusy, DisplayMode.Disabled, DisplayMode.Edit)`.
And show `gblExport.shareUrl` in a selectable label — if the browser blocks the popup from
`Launch()`, nothing happens and the user has no way to know why.

---

## 16. `Scope - Catch`

*Configure run after* `Scope - Main` → **has failed**, **is skipped**, **has timed out**.

Every reference in here must be resolvable **no matter how early the failure happened**. v1 stated
this rule and then broke it three times. An error handler that can fail is not an error handler.

| # | Action | Detail |
|---|---|---|
| 16.1 | `Compose error detail` | expression below |
| 16.2 | `Has log item` — Condition `greater(variables('varLogItemId'),0)` → `Update log item failed` | `Status = Failed`, `ErrorMessage = @{outputs('Compose_error_detail')}` |
| 16.3 | `Can respond` — Condition `equals(variables('varResponded'), false)` → `Respond failed` | `status = Failed`, a message a user can read |
| 16.4 | `Else` → `Send failure email` | to `varActionedBy` — the only channel left once a response has gone |
| 16.5 | `Was file created` — Condition `equals(variables('varFileCreated'), true)` → `Delete partial file` | *Configure run after* includes **has failed** |
| 16.6 | `Terminate failed` | Status `Failed` |

**16.1** — v1's `string(result('Scope_-_Main'))` returns the results of *every* action in the
scope, including the `Get items` bodies and the `Select` outputs. On a 60,000-row export that is
tens of megabytes of JSON being pushed into a SharePoint multi-line text field. Extract just the
failure:

```
substring(
  coalesce(
    string(first(where(result('Scope_-_Main'), equals(item()?['status'],'Failed')))?['error']),
    variables('varMessage'),
    'Scope - Main failed with no action-level error (usually a timeout).'),
  0, 2000)
```

`coalesce` matters: a scope *timeout* produces no failed child action, so the first argument is
null and you would otherwise write an empty error message on precisely the runs worth
investigating. Falling back to `varMessage` also carries §11.6's and §12.5's deliberate-failure
messages through to the log.

**16.3 / 16.4** — this is the async hole in v1. `Respond queued` has already fired on that path,
and only one response may execute per run; a second `Respond failed` fails, taking the catch scope
down with it. The user was promised an email and gets silence, and nothing is logged. The
condition splits the two cases: respond if nobody has, email if someone has.

**16.5** — v1 guarded on `not(empty(varFileName))`, but `varFileName` is set at §7, long before
any file exists. Any failure between §8 and §11.3 entered the catch with a populated filename and
no file, `Delete file` returned 404, and the catch failed. `varFileCreated` is the honest signal.
Set the run-after to continue on failure too — deleting a stray file is best-effort.

---

## 17. `BuildRequestSheets` — payload and result

Full script in `BuildRequestSheets.ts`. Template requirements in `06_Handover_Template_Spec.md`.

**Payload in** — one string parameter, `payloadJson`:

```json
{
  "runId": "a7f3c9e1-…",
  "country": "Romania",
  "exportedUtc": "2026-08-15T14:22:00Z",
  "startRowIndex": 0,
  "totalExpectedRows": 2400,
  "finalize": false,
  "textHeaders": ["PhoneNr","ICCID","Current ICCID","New ICCID","StartDate","EffectiveDate"],
  "requests": [ { …one shaped object per Order List item… } ],
  "typeMap": [
    { "type": "New SIM",     "sheet": "New SIM",     "table": "tbl_NewSIM",
      "required": ["gdid","requestedFor","provider","deliveryAddress"] },
    { "type": "Terminate",   "sheet": "Terminate",   "table": "tbl_Terminate",
      "required": ["gdid","requestedFor","provider","phoneNr"] },
    { "type": "Swap",        "sheet": "Swap",        "table": "tbl_Swap",
      "required": ["gdid","requestedFor","provider","iccid","newSimType"] },
    { "type": "Transfer",    "sheet": "Transfer",    "table": "tbl_Transfer",
      "required": ["gdid","requestedFor","provider","phoneNr","transferdTo"] },
    { "type": "Change plan", "sheet": "Change plan", "table": "tbl_ChangePlan",
      "required": ["gdid","requestedFor","provider","phoneNr","newPlan"] }
  ]
}
```

In the designer, build this with a Compose and reference `outputs('Compose_chunk')` for
`requests`, `outputs('Compose_is_final_chunk')` for `finalize`.

**No column lists in the payload.** The script reads each table's header row from the template and
matches headers to payload keys by normalised name (`Current ICCID` → `currenticcid`). Add a
column to the template and it populates itself if a matching key exists, or stays blank if not —
and the blank ones come back in `unfilledHeaders` so you can confirm they are the intended fill-in
columns. This removes the entire class of "the script's column list drifted from the template"
bug that `01` §7 flags, and it means `Delegate`'s absence is enforced by there being no tab for it.

**Returns** a JSON string — dynamic keys can't be schema'd, same as the import script:

```json
{
  "rowsWritten": 500,
  "cumulativeRows": 2380,
  "breakdown": [{ "sheet": "New SIM", "rows": 1840 }],
  "breakdownText": "New SIM: 1840 · Terminate: 420 · Swap: 120",
  "skippedIds": [1201, 1355],
  "skipped": [
    { "id": 1201, "reason": "unmapped:Upgrade device" },
    { "id": 1355, "reason": "missing:phoneNr,newPlan" }
  ],
  "unfilledHeaders": ["EffectiveDate", "ProviderNotes"],
  "finalized": true
}
```

`cumulativeRows` is read back from the tables themselves rather than accumulated in the flow —
the script has no memory between chunk invocations, so counting from the workbook is the only
number that can't drift.

**Parse JSON schema for §11.7:**

```json
{ "type": "object", "properties": {
  "rowsWritten": {"type":"integer"}, "cumulativeRows": {"type":"integer"},
  "breakdownText": {"type":"string"}, "finalized": {"type":"boolean"},
  "breakdown": {"type":"array","items":{"type":"object","properties":{
      "sheet":{"type":"string"},"rows":{"type":"integer"}}}},
  "skippedIds": {"type":"array"},
  "skipped": {"type":"array","items":{"type":"object","properties":{
      "id":{"type":"string"},"reason":{"type":"string"}}}},
  "unfilledHeaders": {"type":"array","items":{"type":"string"}} } }
```

Leave `skippedIds` untyped — an empty array with a declared item type is a common source of
"expected array of object, got array" on runs where nothing was skipped.

---

## 18. Path summary

| Path | Reads | Writes | File | Response | Typical |
|---|---|---|---|---|---|
| Invalid input | 0 | 1 log | none | immediate | < 2s |
| Not authorised | 1 | 1 log | none | immediate | < 3s |
| No data (Inventory) | 1 probe | 1 log | none | immediate | < 3s |
| No data (Requests) | 1 probe + 1 diag | 1 log | none | immediate | < 5s |
| Sync ≤ 2000 rows | 1 probe | ≤20 batch + 1 log | built from `varShaped` | immediate, with URL | 15–40s |
| Async > 2000 rows | 1 probe + paged | N batch + 1 log | built after responding | immediate, "we'll email it" | 4s to respond |

The sync path is slower than v1 predicted because stamping was added. At 2,000 rows: four script
chunks plus twenty `$batch` calls. If real timings put that near 120 seconds, lower `varThreshold`
rather than dropping the stamping — §12 is the only protection against the one failure that costs
money.

**Note on steady state.** Once the first export for a country is stamped, subsequent exports pick
up only newly-approved requests. The "thousands" figure is a backlog, not a recurring load —
after the first run per country, almost every export takes the sync path.

---

## 19. Still needed

1. **The exact `RequestType` choice values** — they become the `type` keys in `typeMap` and must
   match the sheet and table names in the template. An unmatched value now goes to `skipped` with
   reason `unmapped:<value>` rather than into the workbook.
2. **The `OrderStatus` value meaning approved** — §10.3 assumes `Approved`.
3. **Confirm `Transfer` is provider-facing and distinct from `Delegate`.** `04` defines a Transfer
   sheet, but a transfer between two employees on the same contract may be an internal-only change.

Both choice value sets come from one query:

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$filter=InternalName eq 'RequestType' or InternalName eq 'OrderStatus'&$select=InternalName,Choices
```
