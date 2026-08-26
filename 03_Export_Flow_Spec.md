# SIM Exports — build spec (v3)

Supersedes v2. Written in build order: **every action is defined before anything references it.**
If an expression mentions `outputs('X')` or `body('X')`, action `X` appears earlier in this
document.

**Before you open the designer**, work through `08_Build_Checklist.md`. It covers the lists,
columns, indexes, libraries, environment variables, connection identity and DLP checks this
document assumes already exist. Building the flow first and the prerequisites second is how you
end up debugging a connector error that is actually a missing index.

**Confirmed scope:** one provider per country · one country per export · the admin forwards the
workbook to the provider · Inventory up to 60,000 rows · Requests up to 10,000 per country as a
one-time backlog.

---

## Naming rules — three of them, and all three bite

1. **Power Automate replaces spaces with underscores in expressions.** `Get inventory probe`
   becomes `body('Get_inventory_probe')`.
2. **No parentheses or punctuation in action names.**
3. **Action names must be unique across the entire flow — including across the branches of a
   Switch.** Two Switch cases cannot both contain an action called `Set varShaped`. v2 had this
   in two places and neither would save. Every action name below is unique; keep it that way.

---

## Environment

Nothing below hard-codes a site URL, list GUID or environment ID. They live in **environment
variables** (`08` §2) so the solution can be promoted DEV → UAT → PROD without hand-editing
expressions. Where an expression needs one, it is written as
`@{parameters('simri_SiteUrl')}` and the table maps it to its value.

| Environment variable | Value in PROD |
|---|---|
| `simri_SiteUrl` | `https://deutschebank.sharepoint.com/sites/simri` |
| `simri_InventoryListId` | `6b659861-abd0-4e45-b74e-63e3f69f2648` |
| `simri_OrderListId` | `e390b86b-13bb-4655-b3e6-efd5bd068279` |
| `simri_CountryMatrixId` | `29bf3303-c195-474f-9146-e25d9f0d1b77` |
| `simri_ExportLibrary` | `/SIM Exports/Files` |
| `simri_InventoryTemplate` | `/Shared Documents/SIMRI Templates/Update_Inventory_tetemplate.xlsx` |
| `simri_HandoverTemplate` | `/Shared Documents/SIMRI Templates/Template Approved SIM Request.xlsx` |
| `simri_FlowEnvironmentId` | the Power Platform environment GUID, for the run URL |
| `simri_SupportEmail` | where failure digests go |

Companion documents: log schema `02_Export_Log.md` · source columns `04_Order_List_Schema.md` ·
country config and admins `11_Country_Matrix_Schema.md` · template files and their real metadata
`12_Template_Files.md` · data protection `09_Compliance_and_Data_Protection.md` · build and test
`08_Build_Checklist.md`.

> **The library is called *Documents* but its URL is *Shared Documents*.** Both template paths above
> use the URL form, which is what every path-based connector action needs. This is the exact trap
> §11.3 warns about when it says to take URLs from the connector rather than building them — and
> earlier drafts of this spec had `/Documents/…`, which fails with a file-not-found that reads like
> a permissions problem.

> **Both templates already exist**, in `/Shared Documents/SIMRI Templates/`. Real metadata,
> identifiers and drive IDs are in `12_Template_Files.md`. Two things from it that change what you
> do: the inventory template's filename contains a typo — `tetemplate`, not `template` — and **both
> files carry the sensitivity label "For internal use only"**, which every workbook this flow
> produces will inherit. If that label applies encryption, the Excel Run script action cannot open
> the file and the chunked-write design does not work at all. **Test that before you build
> anything else** — `08` §6 test 0.

---

## What changed from v2

Only the entries that change what you build. Full reasoning in `10_Review_v3_Findings.md`.

| Change | Why |
|---|---|
| Duplicate action names split (`Set varShaped inventory` / `… requests`, `Set varItems inventory full` / `… requests full`) | two actions of the same name in two Switch cases — the flow will not save |
| §11.5 `Compose is final chunk` emits the literal string `'true'` / `'false'` | v2's table showed `lessOrEquals`, which is true on **every** chunk. Chunk 1 would finalize: sheets protected and empty tabs deleted before the rest of the data was written |
| Script payload built with `string(json(concat(…)))`, integers and booleans unquoted | `"finalize":"false"` is a non-empty string, and every non-empty string is truthy in JavaScript. `"startRowIndex":"0"` fails `=== 0`, which is the guard that runs `assertTemplate` |
| §16.1 rebuilt around a `Filter array` action | **`where()` is not a Power Automate function.** v2's error-detail expression cannot be saved |
| `substring` wrapped in a length guard | `substring(s,0,2000)` **throws** when `s` is shorter than 2000 characters |
| §10.2b concurrency claim filters `ID lt varLogItemId` *(removed in v4 — see below)* | the flow's own log item is already `Running` when it checks, so v2's filter made every Requests export reject itself |
| `varActionedBy` escaped for OData | v2 escaped `Country` but not `ActionedBy`, leaving the authorisation filter itself injectable |
| §11.7a — all-requests-skipped path | rows exported = 0 with a file already created: v2 returned a URL to a workbook containing nothing but the Instructions sheet, logged as `No data` |
| §16.6 — stamping compensation | a `$batch` that fails part-way left rows stamped as sent while the file was deleted. Precisely the failure stamping exists to prevent |
| §11.8 `Create sharing link` continues on failure | a tenant sharing policy must not fail an export whose file is already built |
| `Limit Columns by View` must include `ID` | without it `item()?['ID']` is null: blank RequestID in the workbook and nothing to stamp |
| `country` added to the requests Select map | `06` §4's `IsPhoneValid` needs a per-row country and had no way to get one |
| `BuildRequestSheets` rewritten to the `CopyRowsIntoTable` pattern | v2 wrote a full-width row per record, overwriting every check formula with `""`. One export and the provider workbook's validation is dead — silently |
| `Append to string variable` instead of self-referencing `Set variable` | matches the import flow and avoids the documented self-reference hazard |
| §2 gains `varRowsSkipped` | `02` needs it as a filterable column, not buried in `Notes` |
| Environment variables replace hard-coded site URL, list GUIDs and `<envId>` | v2 hard-coded the site URL in three expressions and left `<envId>` as a literal placeholder |
| §10.2 authorises against the existing **SIMRI Country Matrix**, not a new `Country Admins` list | it already holds each country's local admins. A second source of truth for who administers a country is a bug waiting to happen — and its internal names are `field_1`, `field_13`–`field_15`, which nobody would have guessed |

---

## What changed from v3 (this rebuild)

Requests turned out to need far less than v3 built. Confirmed with the process owner: the export is
a **flat, read-only dump** — structurally identical to the Inventory path, not a round-trip provider
workbook.

| Change | Why |
|---|---|
| The provider-handover workbook (five per-type sheets, protected columns, `BuildRequestSheets.ts`) is gone. Requests now uses one `Select` and the same `CopyRowsIntoTable` script Inventory uses | the requirement was always "send the bank's approved requests to the provider in bulk," never a round trip — the workbook existed to support a return leg that was never commissioned |
| Stamping (`ExportedOn`/`ExportRunId`, §12, `$batch`) is gone entirely | confirmed explicitly: no dedup, no write-back to the Order List. A re-run is allowed to re-export the same approved rows; matches Inventory's existing read-only guarantee |
| §10.2b `Claim concurrency` is gone | it existed solely to stop two simultaneous runs both handing over the same unstamped rows. With no stamping there is nothing to double-hand-over — two simultaneous Requests exports are now as harmless as two simultaneous Inventory exports already were |
| §11.7a "nothing was written" and the whole unmapped/missing-field skip concept are gone | a flat dump has no per-row validation gate — whatever the filter returns, it writes, exactly like Inventory |
| The planned return-leg import (`RequestID` matching, `_Meta` sheet, `ExportRunId` linkage) is cancelled, not deferred | there is no workbook round trip left for it to read |
| `{Link}`/`{Path}`/`{Identifier}` bracketed-key expressions fixed to the real `Create file` output keys (`Id`, `Path`) | found during testing: the actual action output has no bracketed keys at all, so `varFileUrl` and the download URL were silently building from `null` |

---

## 0. Prerequisites — the short version

Full checklist in `08_Build_Checklist.md`.

Neither export path writes back to its source list — both are read-only, so there are no new Order
List columns for this flow to create or depend on. (If `ExportedOn`/`ExportRunId`/`EffectiveDate`/
`ProviderNotes` already exist on the Order List from earlier work, they are simply not read or
written by this flow — that is a separate, live-schema decision, not something this spec assumes.)

**Indexes.** Global SIM Inventory: `SIM_Country`. Global Order List: `CountryName`, `OrderStatus`.
If a single country can exceed 5,000 rows in the Order List, add a **compound index** on
`CountryName` + `OrderStatus` — the leading filter clause must narrow below 5,000 or the query is
throttled regardless of what follows it.

**Create `/SIM Exports/Files`** as a document library, and **apply a 90-day retention policy**
(`09` §2). Every file in it contains employee names, GDIDs and delivery addresses.

**Leave trigger concurrency OFF.** Turning it on is irreversible in Power Automate, and there is no
longer any reason to need it — both export paths are read-only, so two simultaneous runs for the
same country just produce two identical files.

---

## 1. Trigger — PowerApps (V2)

| Input | Type | Name | Reference |
|---|---|---|---|
| Text | Text | `Country` | `triggerBody()?['text']` |
| Text | Text | `ExportType` | `triggerBody()?['text_1']` |
| Text | Text | `ActionedBy` | `triggerBody()?['text_2']` |

Confirm the `text_N` suffixes from the first run. They follow input order, and getting them
crossed is the most likely early mistake — `08` §6 makes this test 1.

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
| `varCountryOData` | String | *(empty — set in §4a)* |
| `varExportType` | String | *(empty — set in §3)* |
| `varActionedBy` | String | `trim(coalesce(triggerBody()?['text_2'],''))` |
| `varActionedByOData` | String | *(empty — set in §4a)* |
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
| `varDataErrors` | Integer | `0` |

Twenty-six variables. Three carry the weight of a defect that cost real debugging time:

- **`varThreshold` is an Integer, not a Compose.** A Compose containing `2000` holds the *string*
  `"2000"`, and `add`, `greater` and `lessOrEquals` all throw on a string operand.
- **`varResponded`** — exactly one `Respond to a PowerApp` may execute per run, and the catch
  scope must know whether one already has.
- **`varFileCreated`** — the catch must not try to delete a file that was never created.
- **`varCountryOData` / `varActionedByOData`** — every caller-supplied value that reaches an OData
  filter is escaped once, here, rather than escaped inline at four call sites where one will
  eventually be missed.

### 2.1 Variable scope — read this once and stop worrying about it

**Every variable in this flow is initialised here, at root level, before `Scope - Main` runs.
There is no other `Initialize variable` anywhere in the flow.** That is not a style preference —
Power Automate rejects `Initialize variable` inside a Scope, a Switch case, a Condition branch or
a loop, so it is the only place they can be.

Two consequences follow, and both come up while building §10–§16:

- **Variables are flow-scoped, not container-scoped.** A variable set or appended inside
  `Do until → Switch script → case Requests` is fully readable from `Switch finalize → case
  Requests`, from `Scope - Catch`, and from anywhere else in the run. Nothing is "out of scope"
  because of where it was written. If you find yourself asking *"is this variable in scope here?"*
  the answer is always yes.
- **A variable never reaches a read uninitialised.** Worst case it still holds the initial value
  from the table above — `''`, `0`, `false`, `[]`, `{}`. So a read on a branch where the write
  never happened returns the initial value, not an error. `varNotes` on a run that never enters
  §13 (i.e. any Requests run) is simply `''`.

The one thing to check when reading an accumulated variable is not scope but **whether the write
ran at least once**.

---

## 3. `Set varExportType` — canonicalise and validate in one expression

```
if(equals(toLower(trim(coalesce(triggerBody()?['text_1'],''))),'inventory'),'Inventory',
if(equals(toLower(trim(coalesce(triggerBody()?['text_1'],''))),'requests'),'Requests',
''))
```

An unrecognised value becomes empty, so §10.1's check is simply
`empty(variables('varExportType'))`. A recognised value becomes the canonical casing, so the
Switch cases and the log's Choice column always match — `equals()` and Switch cases are both
case-sensitive.

## 4. `Set varChunkSize`

```
if(equals(variables('varExportType'),'Inventory'), 500, 500)
```

Both are 500 today. Keep the `if` so the two can diverge once you have real timings — the
inventory script and the requests script have very different per-row costs.

## 4a. `Set varCountryOData` and `Set varActionedByOData`

```
Set varCountryOData     →  replace(variables('varCountry'),'''','''''')
Set varActionedByOData  →  replace(variables('varActionedBy'),'''','''''')
```

Doubling a single quote is how OData escapes it. Without this, `Côte d'Ivoire` terminates the
filter string early and the query fails — it looks like a typo and isn't.

**It is not only about odd country names.** `ActionedBy` is a value the caller supplies, and it is
concatenated into the authorisation filter in §10.2. Unescaped, a caller can close the string and
append their own clause — which turns the authorisation check into a check that always passes.
Escaping every caller-supplied value before it reaches a filter is the rule; these two variables
are how the rule is enforced in one place.

---

## 5. `Compose Flow Identity`

```
concat('https://make.powerautomate.com/environments/', parameters('simri_FlowEnvironmentId'),
       '/flows/', workflow()?['name'], '/runs/', workflow()?['run']?['name'])
```

## 6. `Compose file name`

```
concat(formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd_HH-mm-ss'),'_',
       replace(variables('varCountry'),' ','-'),'_',
       variables('varExportType'),'_',
       substring(variables('varRunId'),0,8),'.xlsx')
```

Produces `2026-08-15_14-22-05_Romania_Requests_a7f3c9e1.xlsx`. Built from the *trimmed* country,
so a stray space can't produce a double hyphen. The timestamp is **UTC**, matching the log Title
(`02`) — so a file and its log row always carry the same clock.

`substring(variables('varRunId'),0,8)` is safe: `guid()` is always 36 characters.

## 7. `Set varFileName`

```
outputs('Compose_file_name')
```

---

## 8. `Create log item` — LOG 1

SharePoint **Create item** on SIM Export Log. Status `Running`. Retry: **Exponential, 4**.

**The complete field list is in `02_Export_Log.md` under LOG 1** — as it is for all nine log writes.
That document is written to be built from with the designer open: every write point has its action
name, its `Set varStatus` and `Set varMessage` expressions, every field, the Respond outputs and
the Terminate status. This spec gives the control flow; `02` gives the values.

### Why this runs before the authorisation check, not after

It looks backwards — you write a log row for a caller you have not authorised yet, and every
rejected attempt then costs a second write to update it. Two reasons it is the right way round:

**1. A rejected attempt is the thing most worth recording.** `09` §4 lists "did anyone try to
export a country they do not administer" as an audit question, and `02` has a *Rejected attempts*
view to answer it. Both need a log row for the attempt. Check first and terminate, and an
unauthorised attempt leaves nothing behind but a run-history entry that expires in 28 days.

**2. The log item is created before *any* work, on purpose.** That is the whole point of the
three-point pattern (`02` §Logging points): a run that dies without reaching a terminal action —
platform timeout, admin cancellation, dropped connection — still leaves evidence it happened.
Moving the creation later shrinks that window and reintroduces the blind spot.

The cost of the current order is one extra `Update item` on the invalid and unauthorised paths.
That is a cheap price for an audit trail.

> If you do want to trim the log noise, the only check that could reasonably move above §8 is
> §10.1's input validation — a call with no country produces a log row with no country in it, which
> is nearly useless. Even then it is worth keeping: the app should never send a blank country, so a
> row that says it did is a bug report. Authorisation must stay where it is.

## 9. `Set varLogItemId`

```
body('Create_log_item')?['ID']
```

*Configure run after* → **has succeeded** only. If §8 failed, this is skipped and `varLogItemId`
stays `0`, which every log write below checks for.

> Check the casing on your first run. Some connector versions return `Id` rather than `ID`. `08`
> §6 makes this an explicit verification step because it fails silently — `?['ID']` on a body that
> has `Id` returns null, `varLogItemId` becomes 0, and every subsequent log write is skipped by
> its own guard. The export works perfectly and logs nothing.

---

## 10. `Scope - Main`

*Configure run after* `Set varLogItemId` → **has succeeded**, **has failed**, **is skipped**. A
logging hiccup must never block an export.

### 10.0 The rejection shape

Two paths reject and terminate: invalid input (§10.1) and not authorised (§10.2). Both use the
same six steps in the same order, with different names and messages. It is written once here and
referenced below.

| # | Action | Value |
|---|---|---|
| a | `Set varStatus …` | `Invalid` or `Unauthorised` |
| b | `Set varMessage …` | the message the user will read — expression in `02`, one per path |
| c | `Has log item …` — Condition on `greater(variables('varLogItemId'),0)` → `Update log item …` | **complete field list in `02`**, LOG 1a / 1b / 1c |
| d | `Respond …` | outputs per §15 |
| e | `Set varResponded …` | `true` |
| f | `Terminate …` | status **`Cancelled`** |

Three things this ordering gets right, and all three were wrong in v1:

- **The log update comes before the Terminate.** `Terminate` ends the run immediately — §14.1
  never runs, and `Scope - Catch` does **not** run after a Terminate either. Without step (c) the
  log item stays `Running` forever and `02`'s "Stuck runs" view fills with people who forgot to
  pick a country.
- **The response comes before the Terminate**, or PowerApps waits for its own timeout and the user
  sees nothing at all.
- **`Cancelled`, not `Failed`.** A user typing nothing into a picker is not a flow failure, and the
  run-history failure count is something you will want to trust.

**Every branch that uses this shape is terminal.** Step (f) ends the run, so nothing after it in
that branch executes and there is no "else" to write. The flow reaches §10.3 only when all three
checks have passed — each check's rejection branch is a dead end by construction, which is what
keeps the happy path a single unbranched sequence rather than three levels of nesting.

### 10.1 `Validate inputs` — Condition

```
or(empty(variables('varCountry')),
   empty(variables('varActionedBy')),
   empty(variables('varExportType')))
```

**If true**, run the §10.0 shape with `varStatus` = `Invalid` and:

```
concat('Cannot export: ',
  if(empty(variables('varCountry')),'no country was supplied. ',''),
  if(empty(variables('varActionedBy')),'no user was supplied. ',''),
  if(empty(variables('varExportType')),concat('export type "',trim(coalesce(triggerBody()?['text_1'],'(blank)')),'" is not Inventory or Requests. '),''))
```

**`empty()` does not catch whitespace** — `empty(' ')` is `false`. §2 trims before storing, so a
country of one space is now genuinely empty here.

### 10.2 `Check authorisation`

`Get items` on the **SIMRI Country Matrix** — the list that already defines each country's
configuration and its local admins. Full schema in `11_Country_Matrix_Schema.md`.

```
List:   SIMRI Country Matrix · 29bf3303-c195-474f-9146-e25d9f0d1b77
Filter: field_1 eq '@{variables('varCountryOData')}'
        and Active eq 1
        and (field_13 eq '@{variables('varActionedByOData')}'
          or field_14 eq '@{variables('varActionedByOData')}'
          or field_15 eq '@{variables('varActionedByOData')}')
Top Count: 1
```

`field_1` is CountryName, `field_13`–`field_15` are Local Admin 1, Local Admin 2 and Local Admin
Group. **Those internal names are not guessable from the display names** — ten columns on that list
are `field_N` — so take them from `11` rather than from what the list shows you.

**Wrap the three admin clauses in parentheses.** Without them OData precedence gives you
`(field_1 and Active and field_13) or field_14 or field_15`, and anyone listed as Local Admin 2 for
*any* country passes for *every* country. It looks like a formatting nicety and is not one.

`Active eq 1` keeps a decommissioned country out. Drop the clause deliberately if a country is ever
marked inactive while its backlog is still being worked.

> **`field_15` matches an exact address, not group membership.** It is a text column. If it holds a
> shared mailbox someone signs in as, the filter works. If it holds a distribution list or an AAD
> group, a member of that group is rejected — OData cannot evaluate membership, and the fix is a
> separate `Office 365 Groups — Check group membership` call. `11` §Authorisation has the detail.
> Confirm what is in that column for a country that uses it before go-live.

**If** `equals(length(body('Check_authorisation')?['value']),0)` → §10.0 shape with
`varStatus` = `Unauthorised` and

```
concat('You are not registered as a local admin for ', variables('varCountry'),
       '. If this is wrong, ask a Super Admin to add you to that country''s row in the SIMRI Country Matrix.')
```

`Unauthorised` is its own log status rather than `Invalid`, so a security question can be answered
with a view filter instead of a text search (`02` §Views, "Rejected attempts").

**Be honest about what this is.** There is no trustworthy caller identity on a PowerApps V2
trigger — `ActionedBy` is a parameter the caller supplies, and anyone the app is shared with can
call the flow directly with any parameters. This check stops casual misuse and gives you an audit
trail. It is **not** an access control. `09` §5 records that as a residual risk rather than
implying it is closed.

### 10.3 `Compose requests filter`

```
concat('CountryName eq ''', variables('varCountryOData'),
       ''' and OrderStatus eq ''Approved'' and RequestType ne ''Delegate''')
```

Three clauses, each earning its place:

- `CountryName` — the leading, indexed clause. It must narrow below 5,000 rows or SharePoint
  throttles the query regardless of what follows.
- `OrderStatus eq 'Approved'` — only requests that have cleared approval go out. Assumes the choice
  value is exactly `Approved` — `00` open item O2.
- `RequestType ne 'Delegate'` — a Delegate request never goes to a provider. Without this clause
  Delegate rows are fetched and counted: the probe says "3 rows", the file gets built with 3 rows
  that mean nothing to the recipient.

This is a plain read: nothing is written back, and re-running the export with the same filter
returns the same rows every time. That is by design — the bulk file is sent out fresh on every run,
and whoever receives it is responsible for not re-processing a request they already handled.

> **Verify how `ne` treats a blank `RequestType`.** In CAML, `Neq` on a null value typically
> *excludes* the row — so a request with no type set would vanish from the export entirely rather
> than being reported as unmapped. `08` §6 test 4 covers it. If blanks are excluded, either make
> `RequestType` required on the list or replace the clause with an explicit allow-list of the
> provider-facing values.

`Compose inventory filter`:

```
concat('SIM_Country eq ''', variables('varCountryOData'), '''')
```

### 10.4 `Switch source` — the probe

Switch **On:** `variables('varExportType')`. Two cases, no default case.

**Case `Inventory` → `Get inventory probe`** · SharePoint **Get items**

| Field | Value |
|---|---|
| Site Address | `@{parameters('simri_SiteUrl')}` |
| List Name | Global SIM Inventory · `@{parameters('simri_InventoryListId')}` |
| Filter Query | `@{outputs('Compose_inventory_filter')}` |
| Limit Columns by View | `FlowExport_Inventory` |
| Top Count | `@{add(variables('varThreshold'),1)}` |
| Order By | *(leave blank)* |
| Settings → Pagination | **Off** |
| Settings → Retry Policy | Exponential · Count 4 · Interval `PT10S` |
| Settings → Timeout | *(leave blank — default)* |

**Case `Inventory` → `Set varItems inventory`** · Variables **Set variable**

| Field | Value |
|---|---|
| Name | `varItems` |
| Value | `@{body('Get_inventory_probe')?['value']}` |

**Case `Requests` → `Get requests probe`** · SharePoint **Get items**

| Field | Value |
|---|---|
| Site Address | `@{parameters('simri_SiteUrl')}` |
| List Name | Global Order List · `@{parameters('simri_OrderListId')}` |
| Filter Query | `@{outputs('Compose_requests_filter')}` |
| Limit Columns by View | `FlowExport_Requests` |
| Top Count | `@{add(variables('varThreshold'),1)}` |
| Settings → Pagination | **Off** |
| Settings → Retry Policy | Exponential · Count 4 · Interval `PT10S` |

**Case `Requests` → `Set varItems requests`** · Variables **Set variable**

| Field | Value |
|---|---|
| Name | `varItems` |
| Value | `@{body('Get_requests_probe')?['value']}` |

**Both `Set variable` actions target the same variable, `varItems`.** That is intentional and legal
— only the *action names* have to be unique, not the variable they write. Everything after this
Switch is written once, against `varItems`, and does not care which case ran.

> **The view behind `Limit Columns by View` must contain `ID`.** It is not returned automatically
> when column limiting is on. Without it `item()?['ID']` is null, which means a blank `RequestID`
> column in the provider workbook and an empty stamp list — the export appears to work and
> prevents nothing. The same trap applies in reverse: a column added to the export map but not to
> the view exports empty and errors nowhere. `08` §1.5 lists both views' exact contents.

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

Both export types use the same one-line message shape now — the filter already says exactly what
"nothing" means (no rows matched `CountryName`/`OrderStatus`/`RequestType` for Requests, or
`SIM_Country` for Inventory), so there is nothing left to diagnose with a second query.

| # | Action | Detail |
|---|---|---|
| a | `Is requests export` — Condition | `equals(variables('varExportType'),'Requests')` |
| a1 | ↳ `Set varMessage requests none` | `concat('No approved requests found for ', variables('varCountry'), '.')` |
| b | `Set varMessage inventory none` *(else branch)* | `concat('No SIMs found for ', variables('varCountry'), '.')` |
| c | `Set varStatus no data` | `No data` |
| d | `Has log item no data` — Condition on `varLogItemId > 0` → `Update log item no data` | `02` Log 2 field list, Delivery `None` |
| e | `Respond no data` | §15 |
| f | `Set varResponded no data` | `true` |
| g | `Terminate no data` | status **`Succeeded`** |

**No file is created.** An empty workbook forwarded to a provider is worse than nothing.

**Terminate with `Succeeded`**, not `Cancelled`: "no approved requests" is the process working.
`02` already gives it its own log status so it stays out of the failure views.

#### If TRUE — continue to §11

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
| d | `Has log item queued` — Condition on `varLogItemId > 0` → `Update log item queued` | so a long run doesn't look stuck |
| e | `Respond queued` | §15 — **the app unblocks here** |
| f | `Set varResponded queued` | `true` |
| g | `Switch source full` | full configuration below |

#### `Switch source full` — re-read the whole dataset

Switch **On:** `variables('varExportType')`. Two cases, no default case.

The probe (§10.4) stopped at `varThreshold + 1` rows, so on this path `varItems` holds 2,001 rows
out of a possible 60,000. This Switch replaces it with the complete set. It is the *same query*
with different paging settings — the filter Composes are reused, not rebuilt.

**Case `Inventory` → `Get inventory full`** · SharePoint **Get items**

| Field | Value |
|---|---|
| Site Address | `@{parameters('simri_SiteUrl')}` |
| List Name | Global SIM Inventory · `@{parameters('simri_InventoryListId')}` |
| Filter Query | `@{outputs('Compose_inventory_filter')}` |
| Limit Columns by View | `FlowExport_Inventory` |
| Top Count | `5000` |
| Order By | *(leave blank)* |
| Settings → **Pagination** | **On** · Threshold `100000` |
| Settings → Retry Policy | Exponential · Count 4 · Interval `PT10S` |
| Settings → Timeout | *(leave blank — default)* |

**Case `Inventory` → `Set varItems inventory full`** · Variables **Set variable**

| Field | Value |
|---|---|
| Name | `varItems` |
| Value | `@{body('Get_inventory_full')?['value']}` |

**Case `Requests` → `Get requests full`** · SharePoint **Get items**

| Field | Value |
|---|---|
| Site Address | `@{parameters('simri_SiteUrl')}` |
| List Name | Global Order List · `@{parameters('simri_OrderListId')}` |
| Filter Query | `@{outputs('Compose_requests_filter')}` |
| Limit Columns by View | `FlowExport_Requests` |
| Top Count | `5000` |
| Settings → **Pagination** | **On** · Threshold `100000` |
| Settings → Retry Policy | Exponential · Count 4 · Interval `PT10S` |

**Case `Requests` → `Set varItems requests full`** · Variables **Set variable**

| Field | Value |
|---|---|
| Name | `varItems` |
| Value | `@{body('Get_requests_full')?['value']}` |

Four things about this block:

- **Top Count and Pagination Threshold are different numbers doing different jobs.** With pagination
  **On**, Top Count becomes the *page size* and the threshold is the *total ceiling*. 5000 per page
  up to 100,000 rows is twelve calls at 60,000 rows. Leave Top Count at 5,000 — it is the connector
  maximum per page, and smaller pages just mean more round trips.
- **Pagination Off on the probe, On here** — that is the entire difference between the two Switches,
  and it is why the probe can answer "is this big?" in one cheap call.
- **Both `Set variable` actions write to `varItems`**, the same variable the probe wrote. Legal and
  intended: only *action names* must be unique. Power Automate will not let you have
  `Set varItems full` in both Switch cases, which is why they are named per case.
- **The threshold must exceed your largest country.** At 100,000 against a 60,000-row ceiling there
  is headroom. If a country ever passes 100,000 the connector stops silently at the threshold — the
  same class of silent truncation as §11.5's loop cap, and §11.6's assertion will *not* catch it,
  because `varShaped` would be built from the truncated read. Re-check this number if the estate
  grows.

`Respond to a PowerApp` returns values and the flow keeps running. That is the whole trick: the
user is told "on its way" in about four seconds and a 60,000-row export takes as long as it takes.

**If TRUE** — nothing to do. `varItems` already holds every row from the probe.

> **Scale caveat, worth measuring before you trust it (`08` §6 test 8).** At 60,000 rows,
> `varItems` and `varShaped` each hold a large array, and §11.5 evaluates
> `take(skip(variables('varShaped'), …), …)` once per iteration — 120 iterations over the same
> large array. If that proves slow or hits an action size limit, the fallback is the paging pattern
> the import flow already uses (`../SIM Inventory/Import_Flow_Spec.md` §5): loop over `Get items`
> pages and shape one page at a time, so the whole dataset never sits in a variable. Do not
> restructure pre-emptively; do measure at full volume before go-live.

### 11.2 `Compose template path`

```
if(equals(variables('varExportType'),'Inventory'),
   parameters('simri_InventoryTemplate'),
   parameters('simri_HandoverTemplate'))
```

### 11.3 `Get template` → `Create export file`

| Action | Setting |
|---|---|
| `Get template` | SharePoint **Get file content using path** · Path `@{outputs('Compose_template_path')}` |
| `Create export file` | SharePoint **Create file** · Folder `@{parameters('simri_ExportLibrary')}` · Name `@{variables('varFileName')}` · Content `body('Get_template')` |
| `Set varFileCreated` | `true` |
| `Set varFileUrl` | `concat(parameters('simri_SiteUrl'), '/_layouts/15/download.aspx?SourceUrl=', encodeUriComponent(body('Create_export_file')?['Path']))` |

**The real output has no bracketed keys.** Earlier drafts of this spec assumed `Create file`
returns `{Link}`/`{Path}`/`{Identifier}`, the way `Get file metadata using path` does. It doesn't —
found during testing by reading the action's actual raw output, which only has plain keys: `Id`,
`Name`, `DisplayName`, `Path`, `LastModified`, `Size`, `MediaType`, `IsFolder`, `ETag`, `ItemId`,
`FileLocator`. There is no absolute-link property at all, so `varFileUrl` has to be built.

**`encodeUriComponent` on the whole `Path` only works as a query-string value, not as a URL path
segment** — it escapes the `/` characters too, which is correct here (`Path` is the value of the
`SourceUrl` query parameter) but would break a URL that tried to use `Path` directly as part of the
address. That is exactly the shape `Compose download url` (§11.8) already builds — same site URL,
same `download.aspx?SourceUrl=` wrapper, same encoding — so `varFileUrl` reuses that expression
rather than inventing a second, differently-encoded way to point at the same file.

**Reference the file by `Id` in the Excel actions**, not by path. Referring to a just-created file
by path can hit a brief propagation delay and fail with "file not found" on fast runs. Use the
designer's dynamic-content picker to insert this token rather than hand-typing the expression — it
resolves to the correct underlying key even where the friendly label shown in the picker (e.g.
"Identifier") differs from the actual JSON property name.

### 11.4 `Switch shape` — Switch on `variables('varExportType')`

**Case `Inventory`:** `Shape inventory` — Data Operation **Select**, then
**`Set varShaped inventory`** = `body('Shape_inventory')`.

**From:** `variables('varItems')` · **Map:** the twenty key/value pairs below. Entered in the
normal two-column grid, or pasted whole after switching the map to code view.

```json
{
  "FirstName":    "@{item()?['FirstName']}",
  "LastName":     "@{item()?['LastName']}",
  "PhoneNr":      "@{item()?['PhoneNr']}",
  "Plan":         "@{item()?['Plan']}",
  "ICC_ID":       "@{item()?['ICC_ID']}",
  "GD_ID":        "@{item()?['GD_ID']}",
  "StartDate":    "@{item()?['StartDate']}",
  "SIM_Country":  "@{item()?['SIM_Country']}",
  "Provider":     "@{item()?['Provider']}",
  "CostCenter":   "@{item()?['CostCenter']}",
  "UBR_Code":     "@{item()?['UBR_Code']}",
  "Legal entity": "@{item()?['Legalentity']}",
  "IsVR":         "@{if(item()?['IsVR'],'Yes','No')}",
  "BAN":          "@{item()?['BAN']}",
  "SOC":          "@{item()?['SOC']}",
  "Status":       "@{item()?['Status']?['Value']}",
  "SIM Type":     "@{item()?['SIMType']?['Value']}",
  "Email":        "@{item()?['Email']}",
  "ID":           "@{item()?['ID']}",
  "IMEI":         "@{item()?['IMEI']}"
}
```

**The key is the Excel header; the value reads the SharePoint internal name** — and on four of them
those two differ, which is the whole reason this has to be written out rather than described.

#### Why each awkward one is the way it is

**`CopyRowsIntoTable` matches payload keys to table headers by `header.toLowerCase()` and nothing
else.** It does not strip spaces or underscores. So:

- **`"Legal entity"` keeps its space**, and reads internal name `Legalentity`, which has none.
- **`"SIM Type"` keeps its space**, and reads internal name `SIMType`.

> Requests uses `CopyRowsIntoTable` too (§11.4 below), so this is the one matching rule to remember
> for both export types — not two conventions to keep straight.

**`Status` and `SIM Type` are Choice columns** → `?['Value']`. Without it the cell reads
`[object Object]`.

**`IsVR` is a Boolean** → `Yes` / `No`, not `true`/`false`. This file goes back through the import,
and `ValidateAndMatchImport`'s Boolean conversion accepts `true`, `yes`, `1` and `y`
case-insensitively — so `Yes` round-trips correctly *and* reads properly to a human. Checked
against the script, not assumed.

**`ID` is not optional, and it is the most important key in the map.**

The inventory template is the same file admins fill and **upload back** through the import flow,
whose matching rules (`../SIM Inventory/Import_Flow_Spec.md`) are:

- `ID` present and found → **update** that item
- `ID` present and not found → **failed**; it never falls through to create
- **no `ID`** → match on `ICC_ID` + normalised `PhoneNr`; no match → **create**

So an export that leaves `ID` blank produces a file where any row whose ICCID or phone number was
edited **creates a duplicate inventory item on re-upload** instead of updating the original.
Populating it is what makes export → edit → import a round trip rather than a duplication machine.

#### `columnsCsv` for the Run script action

The same twenty, comma-separated, in header order:

```
FirstName,LastName,PhoneNr,Plan,ICC_ID,GD_ID,StartDate,SIM_Country,Provider,CostCenter,UBR_Code,Legal entity,IsVR,BAN,SOC,Status,SIM Type,Email,ID,IMEI
```

Pass it explicitly rather than letting the script infer keys from the rows. It matters on one edge:
a chunk that legitimately contains zero rows has no keys to infer from, and `columnsCsv` is what
tells the script which columns would have been safe to clear.

#### The columns the script must never touch

`Table_query` is **`A1:AB`** — 28 columns. The writable twenty are **A–S plus U (IMEI)**; the eight
formula columns are **T** and **V–AB**:

| Col | Header | What it checks |
|---|---|---|
| T | `IsPhoneValid` | dial code against `tblCountries[DialCode]`, matched on `SIM_Country` |
| V | `PhoneClean` | the normalised number |
| W | `ICC_Check` | digits only, starts `89`, length 18–22, Luhn, numeric-cell hard error |
| X | `IMEI_Check` | |
| Y | `Date_Check` | |
| Z | `Status_Check` | against `Config!G` |
| AA | `SIMType_Check` | against `Config!H` |
| AB | `RowErrors` | the concatenation a human actually reads |

They are protected automatically — any header **not** in `columnsCsv` is left alone — and
`repairFormulas: true` fills them down from row 2 after each write. Both behaviours already exist
in `CopyRowsIntoTable`; you are configuring them, not building them.

> **Two things to verify against the production template before the first run.** The list above was
> read from `SIM_Data_Validation_DEMO.xlsx`; the file the flow writes into is
> `Update_Inventory_tetemplate.xlsx` (`12_Template_Files.md`), which is later and larger.
>
> 1. **The header row.** A header differing by one space exports that column empty and errors
>    nowhere. Open row 1 and compare.
> 2. **Whether `HasError` exists at all.** It does **not** exist in the DEMO file — that table ends
>    at `AB` / `RowErrors`, and the workbook contains no defined names, no `Config!J2`, and no
>    `UploadGate`. §13 of this spec is written against a `HasError` column and an `UploadGate` named
>    range that may only exist in the production template. **If they are not there either, §13
>    cannot be built as written** — drop it, or add the two cells first. It is optional
>    reporting, so this blocks nothing else.

**Case `Requests`:** `Shape requests` (Select over `variables('varItems')`), then
**`Set varShaped requests`** = `body('Shape_requests')`. Two differently-named `Set` actions again,
for the same reason as §11.1g.

**One flat map, same shape for every row regardless of `RequestType`** — exactly how the Inventory
map above works, and for the same reason: a flat dump has no per-type routing, so every row gets
every column and is blank wherever that column doesn't apply to that row's type (e.g. `newSimType`
is only ever populated on a Swap row). The map, using the explicit allow-list from
`04_Order_List_Schema.md`:

```json
{
  "RequestID":        "@{item()?['ID']}",
  "RequestType":      "@{item()?['RequestType']?['Value']}",
  "CountryName":      "@{item()?['CountryName']}",
  "GDID":             "@{item()?['GDID']}",
  "Requestedfor":     "@{item()?['Requestedfor']}",
  "Provider":         "@{item()?['Provider']}",
  "Ticket_ID":        "@{item()?['Ticket_ID']}",
  "PhoneNr":          "@{item()?['PhoneNr']}",
  "ICCID":            "@{item()?['ICCID']}",
  "SIMType":          "@{item()?['SIMType']?['Value']}",
  "newSimType":       "@{item()?['newSimType']}",
  "PlanName":         "@{item()?['PlanName']}",
  "NewPlan":          "@{item()?['NewPlan']}",
  "VRCompatible":     "@{if(item()?['VRCompatible'],'Yes','No')}",
  "DeliveryAddress":  "@{item()?['DeliveryAddress']}",
  "Location":         "@{item()?['Location']}",
  "simInventoryID":   "@{item()?['simInventoryID']}",
  "TransferdTo":      "@{item()?['TransferdTo']?['DisplayName']}",
  "StartDate":        "@{item()?['StartDate']}"
}
```

`columnsCsv` for the Run script action (same nineteen, header order):

```
RequestID,RequestType,CountryName,GDID,Requestedfor,Provider,Ticket_ID,PhoneNr,ICCID,SIMType,newSimType,PlanName,NewPlan,VRCompatible,DeliveryAddress,Location,simInventoryID,TransferdTo,StartDate
```

Three notes, each of which produces a broken workbook if missed:

- **`?['Value']` on the two Choice columns and `?['DisplayName']` on the User column are not
  optional.** Without them a Choice serialises as an object and lands in the sheet as
  `[object Object]`.
- **`VRCompatible` is a real Boolean**, so `true`/`false` reaches the recipient unless converted.

**Allow-list, not "everything except".** A column added to the Order List next year defaults to
*not* being sent, which is the safe direction. `WorkHistory`, `ApprovalPlanJson`, `Justification`
and `LineManager` never leave the building. `09` §1 records this as the data-minimisation control.

### 11.5 `Do until write chunks`

**Condition:** `greaterOrEquals(variables('varChunkOffset'), length(variables('varShaped')))`

**Limits: Count `5000`, Timeout `PT2H`.** This is not optional. The defaults are Count 60 and
Timeout PT1H, and **when the count limit is hit the loop exits normally — it does not fail**. At
60,000 rows and 500 per chunk that is 120 iterations, so the flow would report success, log the
*intended* row count, return a URL, and hand over a workbook missing half its rows. Nothing
anywhere would show an error. It is the highest-consequence defect this design has to defend
against, precisely because the resulting file looks perfectly normal.

Inside the loop, in order:

| # | Action | Value |
|---|---|---|
| a | `Compose chunk` | `take(skip(variables('varShaped'), variables('varChunkOffset')), variables('varChunkSize'))` |
| b | `Switch script` | two cases below |
| c | `Increment varChunkOffset` | `length(outputs('Compose_chunk'))` |

**(c) increment by the actual chunk length**, not by `varChunkSize` — otherwise the last, partial
chunk overshoots and the loop's own accounting disagrees with §11.6's assertion.

**`Switch script` — case `Inventory` → `Run CopyRowsIntoTable inventory`:**

`tableName: Table_query`, `columnsCsv`, `rows: outputs('Compose_chunk')`,
`startRowIndex: variables('varChunkOffset')`,
`totalExpectedRows: length(variables('varShaped'))`, `spareRows: 200`, `repairFormulas: true`.
**Retry policy: None.**

**`Switch script` — case `Requests` → `Run CopyRowsIntoTable requests`:**

Same script, same action shape as the Inventory case, just pointed at the Requests template's table
and column list: `tableName: Table_Requests`, `columnsCsv` (§11.4's nineteen headers),
`rows: outputs('Compose_chunk')`, `startRowIndex: variables('varChunkOffset')`,
`totalExpectedRows: length(variables('varShaped'))`, `spareRows: 200`, `repairFormulas: false` (the
new Requests template has no formula/check columns to repair — see `08` §1.7). **Retry policy:
None**, for the same reason as the Inventory case: a script that times out at 120s *after* writing
rows would be retried, and the rows written again.

**Two different action names, same script.** `Switch` cases share the naming-uniqueness rule every
other duplicated action in this flow follows (`Set varItems inventory`/`… requests`,
`Set varShaped inventory`/`… requests`) — two cases cannot both contain an action literally called
`Run CopyRowsIntoTable`, or the flow will not save.

There is no payload-building, JSON-parsing, or per-chunk skip accounting on this path any more —
every row the filter (§10.3) returned gets written, exactly like Inventory.

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
| `Set varRowsExported requests` | `length(variables('varShaped'))` |
| `Set varSheetBreakdown requests` | `@{concat('Requests: ', length(variables('varShaped')), ' rows')}` |

Identical shape to the Inventory case above — every row the filter (§10.3) returned is in the file,
so the row count written is exactly the row count shaped. There is no skip/validation concept left
on this path, so there's nothing conditional left to report in `varNotes` here either.

### 11.8 Delivery URLs

| Action | Value |
|---|---|
| `Create sharing link` | SharePoint · File Identifier `body('Create_export_file')?['Id']` · Link type **View** · Scope **Organization**. *Configure run after* on the next action includes **has failed** |
| `Set varShareUrl` | `coalesce(body('Create_sharing_link')?['link']?['webUrl'], '')` |
| `Compose download url` | `concat(parameters('simri_SiteUrl'), '/_layouts/15/download.aspx?SourceUrl=', encodeUriComponent(body('Create_export_file')?['Path']))` |
| `Set varDownloadUrl` | `outputs('Compose_download_url')` |
| `Set varStatus completed` | `Completed` |
| `Set varMessage ready` | `@{concat('Export ready: ', variables('varRowsExported'), ' rows. ', variables('varSheetBreakdown'))}` |

**`Id`/`Path` here, not the bracketed keys earlier drafts used.** See §11.3 — the real `Create file`
output has no `{Identifier}`/`{Path}`/`{Link}` properties, only plain ones.

**`Create sharing link` answers the delivery question `00` left open.** The link carries its own
access grant, so library permissions stop mattering — and a permissions gap was the whole reason
`download.aspx` surfaced as an uncatchable browser error.

**It must not be able to fail the export.** Organisation-scoped link creation can be blocked by a
tenant sharing policy, and a policy change must not destroy an export whose file is already built.
Set the run-after so the flow continues, `coalesce` the result to empty, and let `varDownloadUrl`
carry the delivery. `08` §6 test 9 covers this.

**Scope Organization, not Anyone**: the file contains employee names and delivery addresses. And
note what that means in practice — **the provider cannot open this link.** It is for the admin,
who downloads the workbook and forwards the file itself. See `09` §3 before anyone puts this URL
in an email to a supplier.

---

## 13. `Read upload gate` — free data-quality reporting

Inventory only, inside a Condition on `equals(variables('varExportType'),'Inventory')`, placed
after §11.6 and before §11.7. The template already computes everything needed and v2's flow ignored
it. One script call turns every inventory export into a data-quality audit of that country's
estate, using the Luhn checks, dial-code checks and date checks already built and tested.

**Script: `ReadUploadGate.ts`, in this folder.** It never throws — see below.

### What it reads, and why it looks in four places

The intended source is a named range **`UploadGate`** at `Config!J2`
(`=IF(COUNTIF(Table_query[HasError],"ERROR")=0,"OK","BLOCKED")`) with `UploadGate_ErrorCount` at
`J3`. Both use structured references over `Table_query`, so they cover every written row — unlike
the conditional formatting, which stops at row 1966 in the file `06` was written from.

**That pair does not exist in `SIM_Data_Validation_DEMO.xlsx`** — that workbook has no defined
names at all — and it is unconfirmed in `Update_Inventory_tetemplate.xlsx`, which is the file the
flow writes into. So rather than depend on a cell that may not be there, the script degrades:

| # | Source | `source` returns |
|---|---|---|
| 1 | named ranges `UploadGate` / `UploadGate_ErrorCount` | `namedRange` |
| 2 | literal cells `Config!J2` / `Config!J3` | `cell:Config!J2` |
| 3 | `Table_query[HasError]`, counting `ERROR` | `table:HasError` |
| 4 | `Table_query[RowErrors]`, counting non-empty | `table:RowErrors` |

**Read `source` on your first run** — it tells you what the production template actually contains.
`table:RowErrors` means the gate cells are worth adding, but nothing is broken without them.

### Returns

```json
{
  "available": true,
  "gate": "BLOCKED",
  "errorCount": 47,
  "rowCount": 12480,
  "source": "table:HasError",
  "sampleErrors": ["ICC_ID: Luhn check failed", "PhoneNr: dial code does not match Romania"],
  "note": ""
}
```

**`available` is the field that matters.** When the script cannot measure anything it returns
`available: false`, `gate: "UNKNOWN"`, `errorCount: -1` and a `note` saying why. It never returns a
zero it did not measure — "0 errors" and "could not check" are different facts and the log must not
confuse them.

`rowCount` counts rows carrying an identifier, not `getRowCount()`. `CopyRowsIntoTable` leaves
`spareRows` blank inside the table so an admin can type below the data without falling out of it,
which overstates the table's row count by up to 200.

### Actions

| # | Action | Setting |
|---|---|---|
| a | `Run ReadUploadGate` | Excel Online **Run script** · File `@{body('Create_export_file')?['Id']}` · Script `ReadUploadGate` · `forceRecalculate` **false** · Retry **None** |
| b | `Parse gate result` | Parse JSON over `json(body('Run_ReadUploadGate')?['result'])`, schema below. *Run after:* **has succeeded** and **has failed** |
| c | `Set varDataErrors` | `if(body('Parse_gate_result')?['available'], body('Parse_gate_result')?['errorCount'], -1)` · same run-after |
| d | `Append varNotes data errors` | **Append to string variable** on `varNotes`, expression below · same run-after |

**Leave `forceRecalculate` false.** `CopyRowsIntoTable` restores calculation to automatic and does
a full rebuild on its last chunk, so the check columns are current by the time this runs. Set it
true only if you ever pass `deferCalculationRestore` on that action, or if a test shows stale
values — a full rebuild over 60,000 rows of array formulas is not cheap, and this shares the same
120-second Run script budget as everything else.

**`Parse gate result` schema:**

```json
{ "type": "object", "properties": {
  "available": {"type":"boolean"}, "gate": {"type":"string"},
  "errorCount": {"type":"integer"}, "rowCount": {"type":"integer"},
  "source": {"type":"string"}, "note": {"type":"string"},
  "sampleErrors": {"type":"array"} } }
```

Leave `sampleErrors` untyped — an empty array with a declared item type throws on the runs where
there is nothing to report.

**`Append varNotes data errors`:**

```
@{if(not(body('Parse_gate_result')?['available']),
     concat(' | Data-quality check unavailable: ', body('Parse_gate_result')?['note']),
  if(greater(variables('varDataErrors'),0),
     concat(' | ', variables('varDataErrors'), ' of ', body('Parse_gate_result')?['rowCount'],
            ' exported row(s) fail validation — see the RowErrors column',
            if(greater(length(body('Parse_gate_result')?['sampleErrors']),0),
               concat('. For example: ', join(body('Parse_gate_result')?['sampleErrors'], ' · ')),
               ''),
            '.'),
     ''))}
```

Three outcomes, three different notes: it could not check, it found problems and names a couple of
them, or it found none and stays silent. A count on its own sends someone hunting; *"47 of 12,480
rows fail validation — for example: ICC_ID: Luhn check failed"* does not.

### It must not be able to fail the export

Retry **None**, and every action after it continues on failure. **Do not block on the gate** — the
export is a read, and the admin may be exporting precisely because they want to see the bad rows.
Blocking would also make a reporting nicety capable of destroying a completed 60,000-row export,
which is a bad trade in any direction.

The script itself never throws for the same reason: on any problem it returns `available: false`
with a reason rather than raising. The run-after settings are the second lock, for the case where
the connector fails before the script runs at all.

---

## 14. `Was async` — respond or email

```
equals(variables('varAsync'), true)
```

- **If TRUE** → `Send export email` to `variables('varActionedBy')` with `varShareUrl` (falling
  back to `varDownloadUrl` when empty) as a **link**, never an attachment. A 60,000-row workbook is
  around 28 MB against Outlook's ~25 MB cap. Style it on the import emails in
  `../SIM Inventory/Email_Templates.md`. Include `varSheetBreakdown`.
- **If FALSE** → `Respond ready` (§15), then `Set varResponded ready` = `true`.

Exactly one `Respond to a PowerApp` executes on every path: `Respond invalid`,
`Respond unauthorised`, `Respond no data`, `Respond queued` or `Respond ready`.

## 14.1 `Update log item` — LOG 2

Last action **inside** `Scope - Main`, wrapped in a condition on
`greater(variables('varLogItemId'), 0)`. Outside the scope, a failure sending the email would leave
the log claiming `Running` on a run that produced a file.

Repopulate **every** field — SharePoint's `Update item` writes the whole item and blanks anything
left empty. **Complete field list in `02_Export_Log.md` under LOG 2.** Two of them are worth
repeating here because they were wrong in v1:

```
Delivery = @{if(equals(variables('varRowsExported'),0),'None',if(variables('varAsync'),'Emailed','Link returned'))}
Status   = @{if(equals(variables('varRowsExported'),0),'No data',variables('varStatus'))}
```

`Delivery` comes from `varAsync`, not from a row count. The sync/async decision was made once, at
§11.1, before the response went out — a run that already told the caller "we'll email it" and
responded `Queued` must log `Emailed` no matter what the final row count turns out to be, or the
field would misreport exactly the delivery it actually used.

`varShareUrl` goes to the email (§14) and the response (§15), not to the log — the sharing link is
a delivery artefact, and `varFileUrl` (§11.3) is the stable address of the file itself.

---

## 15. Respond to a PowerApp — outputs

The same five outputs on **every** Respond action, so PowerApps has one shape to handle.

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
IfError(
    Set(gblExport, SIMExports.Run(
        Trim(drpCountry.Selected.Value), "Requests", User().Email)),
    Set(gblExport, {status: "Failed",
                    message: "The export could not be started. Please try again, and tell IT if it keeps happening.",
                    fileUrl: "", shareUrl: "", rows: 0})
);
UpdateContext({locBusy: false});
Switch(gblExport.status,
  "Completed",    Launch(gblExport.fileUrl),
  "Queued",       Notify(gblExport.message, NotificationType.Information),
  "No data",      Notify(gblExport.message, NotificationType.Warning),
  "Invalid",      Notify(gblExport.message, NotificationType.Error),
  "Unauthorised", Notify(gblExport.message, NotificationType.Error),
                  Notify(gblExport.message, NotificationType.Error)
)
```

**`IfError` is not optional.** If the flow fails before any Respond runs — or if `Scope - Catch`
itself fails — `Run()` throws and, without the wrapper, the app shows a raw Power Fx error and
`locBusy` is never cleared, leaving the Export button disabled until the screen is reloaded.

Bind the Export button's `DisplayMode` to `If(locBusy, DisplayMode.Disabled, DisplayMode.Edit)`.
And show `gblExport.shareUrl` in a selectable label — if the browser blocks the popup from
`Launch()`, nothing happens and the user has no way to know why.

---

## 16. `Scope - Catch`

*Configure run after* `Scope - Main` → **has failed**, **is skipped**, **has timed out**.

Every reference in here must be resolvable **no matter how early the failure happened.** An error
handler that can fail is not an error handler. Every action below refers only to variables,
literals, or actions defined inside this scope.

| # | Action | Detail |
|---|---|---|
| 16.1 | `Filter array failed actions` → `Compose error detail` | below |
| 16.2 | `Has log item failed` — Condition `greater(variables('varLogItemId'),0)` → `Update log item failed` | `02` Log 3 |
| 16.3 | `Can respond` — Condition `equals(variables('varResponded'), false)` → `Respond failed` | `status = Failed`, a message a user can read |
| 16.4 | `Else` → `Send failure email` | to `varActionedBy` — the only channel left once a response has gone |
| 16.5 | `Was file created` — Condition `equals(variables('varFileCreated'), true)` → `Delete partial file` | *Configure run after* includes **has failed** |
| 16.6 | `Terminate failed` | Status `Failed` |

### 16.1 Extracting the error

**`where()` is not a Power Automate expression function.** v2 used it and the expression cannot be
saved. The collection functions are `contains, empty, first, intersection, item, join, last,
length, reverse, skip, sort, take, union` — filtering a collection needs the **Filter array**
action.

**`Filter array failed actions`** — Data Operation:

```
From:  result('Scope_-_Main')
Where: item()?['status']  is equal to  Failed
```

**`Compose error detail`:**

```
if(greater(length(coalesce(string(first(body('Filter_array_failed_actions'))?['error']?['message']),'')), 0),
   if(greater(length(string(first(body('Filter_array_failed_actions'))?['error']?['message'])), 1900),
      concat(substring(string(first(body('Filter_array_failed_actions'))?['error']?['message']), 0, 1900), ' … truncated'),
      string(first(body('Filter_array_failed_actions'))?['error']?['message'])),
   if(greater(length(variables('varMessage')), 0),
      variables('varMessage'),
      'Scope - Main failed with no action-level error, which usually means a timeout. See the flow run link.'))
```

Three things it is defending against:

- **`substring` throws when the string is shorter than the requested length.** `substring(s,0,2000)`
  on a 40-character error message is an error inside the error handler. The length guard is the
  same pattern `../SIM Inventory/Logging_System.md` already uses for its 60,000-character cap.
- **`string(result('Scope_-_Main'))` may be enormous.** `result()` returns the results of *every*
  action in the scope, including the `Get items` bodies. On a 60,000-row export that is tens of
  megabytes of JSON pushed into a SharePoint multi-line text field with a 63,999-character limit.
- **A scope timeout produces no failed child action**, so the filter returns empty and the fallback
  chain matters. Falling back to `varMessage` also carries §11.6's deliberate-failure message
  through to the log.

Note that `coalesce` alone is not enough here: an empty string is not null, so
`coalesce('', variables('varMessage'))` returns the empty string. Hence the explicit
`greater(length(…),0)` tests.

Also note that `result()` returns the scope's **top-level** actions. A failure deep inside
`Switch script` surfaces as the container's result with the underlying error nested in it, so the
extracted message is sometimes one level less specific than the run history. The `FlowRun` link in
the log is the full detail; this field is the summary.

### 16.3 / 16.4 — why the response is conditional

This is the async hole v1 had. `Respond queued` has already fired on that path, and only one
response may execute per run; a second `Respond failed` fails, taking the catch scope down with it.
The user was promised an email and gets silence, and nothing is logged. The condition splits the
two cases: respond if nobody has, email if someone has.

### 16.5 — why the guard is `varFileCreated`

v1 guarded on `not(empty(varFileName))`, but `varFileName` is set at §7, long before any file
exists. Any failure between §8 and §11.3 entered the catch with a populated filename and no file,
`Delete file` returned 404, and the catch failed. `varFileCreated` is the honest signal. Set the
run-after to continue on failure too — deleting a stray file is best-effort.

---

## 17. Requests write path — no separate payload section needed

v3 had a `BuildRequestSheets` payload/result section here. It's gone along with the script: the
Requests path now reuses §11.4's flat Select map and §11.5's `Run CopyRowsIntoTable` call directly,
the same pattern §11.4–§11.6 already document in full for Inventory. There is no JSON payload to
build, no result to parse, and no separate schema — one `Select`, one script call, same as
Inventory. `CopyRowsIntoTable` only writes headers with a matching key in the Select map — any other
column on the template is left alone. The new Requests template has no formula/check columns of its
own to protect (§11.5's `repairFormulas: false`), so this matters less here than it does for
Inventory's `Table_query`, but the behaviour is the same script, same rule, on both paths.

---

## 17a. Action settings reference — retry, timeout, run-after, concurrency

Every setting that is **not** a connector field, in one place, because in the designer they live
behind the `…` → **Settings** menu on each action and are the easiest thing to forget.

### Which actions even have these settings

| Action type | Retry Policy | Timeout | Run After | Concurrency |
|---|---|---|---|---|
| SharePoint, Excel Online, Outlook — any **connector** action | ✔ | ✔ | ✔ | — |
| Respond to a PowerApp | — | ✔ | ✔ | — |
| Compose, Select, Filter array, Parse JSON, Join | **✖ none exists** | ✔ | ✔ | — |
| Initialize / Set / Increment / Append variable | **✖ none exists** | ✔ | ✔ | — |
| Condition, Switch, Scope, Terminate | **✖ none exists** | — | ✔ | — |
| Do until | **✖ none exists** | ✔ *(Limits: Count + Timeout)* | ✔ | — |
| Apply to each | — | ✔ | ✔ | ✔ |

**There is no retry policy on a Compose or a Set variable.** They are not connector calls. If you
go looking for one you will not find it, and that is correct rather than a missing setting.

**There are no `Apply to each` actions in this flow at all.** That is deliberate — §11.5 is a
`Do until` loop over offsets, and shaping is done by a single `Select` rather than a loop, for both
export types.

### Retry policy — the default is wrong in two places

**Every connector action defaults to Exponential, Count 4.** You only change it where a retry is
unsafe:

| Action | Retry | Why |
|---|---|---|
| `Create log item` §8 | Exponential · 4 · PT10S | write to our own log; a duplicate row is impossible because it returns the ID we then reuse |
| All `Update log item …` | Exponential · 4 · PT10S | idempotent — writes the same field values |
| `Check authorisation` §10.2 | Exponential · 4 · PT10S | reads |
| `Get inventory/requests probe` §10.4, `… full` §11.1g | Exponential · 4 · PT10S | reads |
| `Get template` §11.3 | Exponential · 4 · PT10S | read |
| `Create export file` §11.3 | Exponential · 4 · PT10S | the filename carries the RunId, so a retry overwrites the same file rather than making a second one |
| **`Run CopyRowsIntoTable inventory` / `… requests` §11.5** | **None** | a script that times out at 120s *after* writing rows would be retried, and the rows written again |
| **`Run ReadUploadGate` §13** | **None** | same class of action; and it must not be able to fail the run at all |
| `Create sharing link` §11.8 | None | it is allowed to fail; the flow falls back to the download URL |
| `Delete partial file` §16.5 | None | a 404 on retry is noise; best-effort by design |
| `Send export email` §14, `Send failure email` §16.4 | Exponential · 4 · PT10S | a duplicate email is better than a missing one |

### Timeout

**Leave every action timeout blank.** The defaults are correct for this flow, and the limit that
actually binds is not an action timeout:

| Real limit | Value | Where it bites |
|---|---|---|
| PowerApps flow call | ~120 seconds | the whole sync path — `varThreshold` exists to stay under it |
| Excel Online **Run script** | 120 seconds, hard | why §11.5 chunks at all. An action timeout cannot raise it |
| `Do until write chunks` §11.5 | **Count `5000` · Timeout `PT2H`** | must be set — defaults are Count 60 / PT1H and the loop **exits normally** at the cap |

This is the only `Do until` limit you type in this flow. Everything else is default.

> If a paginated `Get items` over 60,000 rows ever does time out, that is a signal to move to the
> import flow's page-at-a-time pattern (§11.1's scale note), not to raise a timeout.

### Configure run after — every non-default setting

Default everywhere is **has succeeded** only. These are the exceptions, and each exists to stop one
specific failure:

| Action | Run after | Why |
|---|---|---|
| `Set varLogItemId` §9 | **has succeeded** only *(explicitly)* | if `Create log item` failed, this must be skipped so `varLogItemId` stays `0` |
| `Scope - Main` §10 | has succeeded · **has failed** · **is skipped** | a logging hiccup must never block an export |
| `Set varShareUrl` §11.8 | has succeeded · **has failed** | a blocked sharing link must not fail an export whose file is already built |
| `Set varDataErrors` §13 | has succeeded · **has failed** | a data-quality read must not fail the export it reports on |
| `Scope - Catch` §16 | **has failed** · **is skipped** · **has timed out** | the whole point of the catch |
| `Delete partial file` §16.5 | has succeeded · **has failed** | deleting a stray file is best-effort |
| every action after a `Delete …` in the catch | has succeeded · **has failed** | one failed cleanup must not stop the rest of the handler |

**Terminate is not covered by run-after.** `Scope - Catch` does **not** run after a `Terminate`, no
matter how its run-after is configured. That is why every rejection path in §10.0 logs and responds
*before* it terminates.

### Trigger concurrency

**Off. Do not turn it on.** It is irreversible in Power Automate — the designer warns you and means
it — and there is no longer any benefit to it: both export types are read-only, so simultaneous runs
for the same country just produce two identical files rather than any conflict worth queueing
against.

---

## 18. Path summary

| Path | Reads | Writes | File | Response | Typical |
|---|---|---|---|---|---|
| Invalid input | 0 | 1 log | none | immediate | < 2s |
| Not authorised | 1 | 1 log | none | immediate | < 3s |
| No data | 1 probe | 1 log | none | immediate | < 3s |
| Sync ≤ 2000 rows | 1 probe | ≤4 script chunks + 1 log | built from `varShaped` | immediate, with URL | 20–50s |
| Async > 2000 rows | 1 probe + paged | N script chunks + 1 log | built after responding | immediate, "we'll email it" | ~4s to respond |

Both export types now follow exactly these five paths — Requests has no path of its own left in
this table, because there's nothing left that only Requests does.

At 2,000 rows the sync path is four script chunks plus a sharing link. **If real timings put that
near 120 seconds, lower `varThreshold`.** `02`'s `DurationSeconds` column and its "Threshold tuning"
view exist to make that a measured decision.

**Every run reads whatever currently matches the filter.** There is no steady-state shrinkage the
way a stamped design would have — Requests returns every currently-Approved, non-Delegate request
for the country on every run, the same way Inventory returns every current row. Volume depends
entirely on how many requests are sitting in `Approved` at the moment the export runs, not on how
recently the country was last exported.

---

## 19. Monitoring

The catch scope logs and responds, but nobody watches a SharePoint list. Build the **scheduled
digest flow** in `02_Export_Log.md` §Alerting before go-live, not after the first missed failure.

The one thing an in-catch email cannot do, and the digest can: surface the runs that reached
neither terminal action. If the catch never ran, an email inside it never sends.

---

## 20. Still needed

Open items are tracked in `00_Design_Decisions.md` §Open items. Repeating the two that block this
document:

1. **The exact `RequestType` choice values** — §10.3's filter compares `RequestType ne 'Delegate'`
   literally, and a mismatched value means the exclusion silently does nothing.
2. **The `OrderStatus` value meaning approved** — §10.3 assumes `Approved`.

Both choice value sets come from one query:

```
_api/web/lists(guid'<simri_OrderListId>')/fields?$filter=InternalName eq 'RequestType' or InternalName eq 'OrderStatus'&$select=InternalName,Choices
```

### If "export all my countries" is ever asked for

Recorded here so it is found by whoever goes looking. Today the trigger takes one `Country` and
that is a confirmed decision (`00`). Making it a list means:

- `Country` becomes a delimited string or a JSON array; §4a escapes each element
- Everything from §10.3 to §14 moves inside an `Apply to each` over countries, **concurrency 1**
- One file, one sharing link and one log item **per country** — `varFileName`, `varFileUrl`,
  `varLogItemId` and the whole log-write pattern become per-iteration, which is the real cost
- The response returns a summary rather than a single URL, and the async threshold is evaluated on
  the total rather than per country

The catch works unchanged, because it is already keyed on country. The expensive part is that every
single-file assumption becomes a collection — which is exactly the same shape of change `00`'s
one-provider-per-country note describes, and for the same reason.
