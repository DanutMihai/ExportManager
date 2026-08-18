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
| `simri_InventoryTemplate` | `/Documents/SIM_Inventory_TEMPLATE.xlsx` |
| `simri_HandoverTemplate` | `/Documents/SIM_Request_Handover_TEMPLATE.xlsx` |
| `simri_FlowEnvironmentId` | the Power Platform environment GUID, for the run URL |
| `simri_SupportEmail` | where failure digests go |

Companion documents: log schema `02_Export_Log.md` · source columns `04_Order_List_Schema.md` ·
country config and admins `11_Country_Matrix_Schema.md` · handover template
`06_Handover_Template_Spec.md` · script `BuildRequestSheets.ts` · data protection
`09_Compliance_and_Data_Protection.md` · build and test `08_Build_Checklist.md`.

> **Rename the inventory template before you start.** It is currently
> `SIM_Data_Validation_DEMO.xlsx`. A file with `DEMO` in the name is a production dependency of
> this flow and will eventually be "cleaned up" by someone who reads the filename literally.
> Rename it, keep the demo copy with its sample rows somewhere separate, and check first whether
> anything links to the old name — admins may have bookmarked it as the upload template for the
> import process.

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
| §10.2b concurrency claim filters `ID lt varLogItemId` | the flow's own log item is already `Running` when it checks, so v2's filter made every Requests export reject itself |
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

## 0. Prerequisites — the short version

Full checklist in `08_Build_Checklist.md`. The four that change the flow's shape:

**Order List — four new columns:**

| Internal name | Type | Purpose |
|---|---|---|
| `ExportedOn` | Date and Time | Stamped when a request is handed over. Empty = not yet sent. **Read by this flow's filter (§10.3) and written by §12.** |
| `ExportRunId` | Single line of text | Which export sent it. Matches `_Meta` in the workbook and `RunId` in the log. **Written by §12, and the key §16.6 uses to undo a partial stamp.** |
| `EffectiveDate` | Single line of text | Return-leg only — the provider fills it for every type except New SIM. Not written by this flow. |
| `ProviderNotes` | Multiple lines, plain text | Return-leg only — provider free text. Not written by this flow. |

Create them with plain names (no spaces, no underscores) and rename afterwards, then **verify the
internal names** — SharePoint sometimes encodes an underscore as `_x005f_`:

```
_api/web/lists(guid'<simri_OrderListId>')/fields?$select=InternalName,Title&$filter=Hidden eq false
```

**Indexes.** Global SIM Inventory: `SIM_Country`. Global Order List: `CountryName`, `OrderStatus`,
`ExportedOn`. If a single country can exceed 5,000 rows in the Order List, add a **compound index**
on `CountryName` + `OrderStatus` — the leading filter clause must narrow below 5,000 or the query
is throttled regardless of what follows it.

**Create `/SIM Exports/Files`** as a document library, and **apply a 90-day retention policy**
(`09` §2). Every file in it contains employee names, GDIDs and delivery addresses.

**Leave trigger concurrency OFF.** Turning it on is irreversible in Power Automate. §10.2b uses a
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
| `varReExport` | Boolean | `coalesce(triggerBody()?['boolean'], false)` |
| `varFileName` | String | *(empty)* |
| `varFileUrl` | String | *(empty)* |
| `varDownloadUrl` | String | *(empty)* |
| `varShareUrl` | String | *(empty)* |
| `varRowsExported` | Integer | `0` |
| `varRowsSkipped` | Integer | `0` |
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

Thirty-three variables. Five carry the weight of a defect that cost real debugging time:

- **`varThreshold` is an Integer, not a Compose.** A Compose containing `2000` holds the *string*
  `"2000"`, and `add`, `greater` and `lessOrEquals` all throw on a string operand.
- **`varResponded`** — exactly one `Respond to a PowerApp` may execute per run, and the catch
  scope must know whether one already has.
- **`varFileCreated`** — the catch must not try to delete a file that was never created.
- **`varStampedCount`** — §16.6 needs to know whether there is anything to undo.
- **`varCountryOData` / `varActionedByOData`** — every caller-supplied value that reaches an OData
  filter is escaped once, here, rather than escaped inline at four call sites where one will
  eventually be missed.

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
rejected attempt then costs a second write to update it. Three reasons it is the right way round,
and the third is the one that would actually break if you reordered:

**1. A rejected attempt is the thing most worth recording.** `09` §4 lists "did anyone try to
export a country they do not administer" as an audit question, and `02` has a *Rejected attempts*
view to answer it. Both need a log row for the attempt. Check first and terminate, and an
unauthorised attempt leaves nothing behind but a run-history entry that expires in 28 days.

**2. The log item is created before *any* work, on purpose.** That is the whole point of the
three-point pattern (`02` §Logging points): a run that dies without reaching a terminal action —
platform timeout, admin cancellation, dropped connection — still leaves evidence it happened.
Moving the creation later shrinks that window and reintroduces the blind spot.

**3. §10.2b's concurrency claim needs this item to already exist.** The claim is
`ID lt varLogItemId` — "is there a Running Requests export for this country whose log item is
*older than mine*". Creating the row **is** the claim; the ID is the ticket, and the comparison is
what makes two simultaneous clicks resolve deterministically into one winner.

Check before creating and you lose the tie-break entirely: both runs would look for "any Running
export", both would find nothing because neither has registered yet, and both would proceed to hand
the same requests to the provider. The race window gets *wider*, not narrower — and the failure it
produces is the double handover this design spends §12 preventing.

The cost of the current order is one extra `Update item` on the invalid, unauthorised and claim
paths. That is a cheap price for an audit trail and a working claim.

> If you do want to trim the log noise, the only check that could reasonably move above §8 is
> §10.1's input validation — a call with no country produces a log row with no country in it, which
> is nearly useless. Even then it is worth keeping: the app should never send a blank country, so a
> row that says it did is a bug report. Authorisation and the claim must stay where they are.

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

Three paths reject and terminate: invalid input (§10.1), not authorised (§10.2), and a
concurrency claim (§10.2b). All three use the same six steps in the same order, with different
names and messages. It is written once here and referenced below.

| # | Action | Value |
|---|---|---|
| a | `Set varStatus …` | `Invalid`, `Unauthorised` or `Blocked` |
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

### 10.2b `Claim concurrency` — Requests only

Two nested Conditions with a `Get items` between them. Written out in full, because the nesting is
where this gets built wrong:

```
◆ Is requests export claim          Condition · equals(variables('varExportType'),'Requests')
│
├─ IF YES
│   │
│   ├─ ▤ Claim concurrency          SharePoint · Get items on SIM Export Log
│   │
│   └─ ◆ Claim rejected             Condition · greater(length(body('Claim_concurrency')?['value']), 0)
│       │
│       ├─ IF YES  ── the §10.0 rejection shape, six actions, ending in Terminate
│       │   ├─ {x} Set varStatus claim rejected      'Blocked'
│       │   ├─ {x} Set varMessage claim rejected     expression below
│       │   ├─ ◆ Has log item claim                  greater(variables('varLogItemId'), 0)
│       │   │   └─ IF YES ▤ Update log item claim    02 · LOG 1c field list
│       │   ├─ ⚡ Respond claim rejected              §15 outputs
│       │   ├─ {x} Set varResponded claim            true
│       │   └─ ⛭ Terminate claim rejected            status Cancelled   ←── THE RUN ENDS HERE
│       │
│       └─ IF NO   ── nothing. An export is not in progress, so this one continues.
│
└─ IF NO           ── nothing. Inventory exports do not claim; two of them are harmless.

§10.3 ── continues here, at Scope - Main level, outside both Conditions
```

**`Claim concurrency` — Get items on SIM Export Log:**

```
Filter: Status eq 'Running' and ExportType eq 'Requests'
        and Country eq '@{variables('varCountryOData')}'
        and ID lt @{variables('varLogItemId')}
        and Created gt '@{addMinutes(utcNow(),-30)}'
Top Count: 1
Order By: ID desc
```

Do **not** put `Limit Columns by View` on this one — the message below reads `Created` and
`ActionedBy_email` off the returned item, and column limiting would blank them.

**`Set varMessage claim rejected`:**

```
concat('An export for ', variables('varCountry'), ' is already running — started at ',
       formatDateTime(first(body('Claim_concurrency')?['value'])?['Created'],'HH:mm'),
       ' UTC by ', first(body('Claim_concurrency')?['value'])?['ActionedBy_email'],
       '. Wait for it to finish, then try again.')
```

Top Count 1 with `Order By ID desc` returns the **most recent** run that started before this one,
which is the one worth naming in the message. `first(…)` is safe because the branch only runs when
the array is non-empty.

Three things about the shape above that are easy to get wrong:

- **The YES branch is terminal.** `Terminate` ends the run immediately, so nothing after it in that
  branch executes, `Scope - Catch` does **not** run, and §14.1 never fires — which is exactly why
  the log update sits *before* the Respond and the Respond sits *before* the Terminate. Get that
  order wrong and the log stays `Running` forever while PowerApps waits for a response that never
  comes.
- **Both NO branches are genuinely empty.** No else-actions, no compose, nothing. The flow simply
  falls through to §10.3.
- **§10.3 is a sibling of `Is requests export claim`, not a child of it.** In the designer it sits
  at `Scope - Main` level, after the outer Condition closes.

> Verify the `Created gt` literal on the first run. The SharePoint connector accepts a quoted ISO
> string (`Created gt '2026-08-17T16:00:00Z'`), which is what `addMinutes(utcNow(),-30)` produces —
> but a filter that silently matches nothing looks identical to "no export is running", and that is
> the failure this whole section exists to prevent. Test 19 in `08` §6 is the check.

**`ID lt varLogItemId` is the whole trick, and v2 was missing it.** This flow's own log item was
created at §8 with status `Running`, before this check runs. A filter without the ID clause finds
that item and the export rejects itself — every single time. With it, a run only defers to an
export that started *before* it did, so two simultaneous clicks produce one winner and one clear
message rather than two rejections or two handovers.

Why not trigger concurrency: turning it on is **irreversible**, and it would queue inventory
exports behind requests exports for no benefit. This claim is reversible, visible in the list, and
it names the run rather than silently queueing.

Why only Requests: two simultaneous inventory exports produce two identical read-only files, which
is harmless. Two simultaneous requests exports both read the same unstamped rows and both hand
them over.

### 10.3 `Compose requests filter`

```
concat('CountryName eq ''', variables('varCountryOData'),
       ''' and OrderStatus eq ''Approved'' and RequestType ne ''Delegate''',
       if(variables('varReExport'), '', ' and ExportedOn eq null'))
```

Three clauses, each earning its place:

- `CountryName` — the leading, indexed clause. It must narrow below 5,000 rows or SharePoint
  throttles the query regardless of what follows.
- `RequestType ne 'Delegate'` — a Delegate request never goes to a provider. Without this clause
  Delegate rows are fetched and counted: the probe says "3 rows", the script writes 0 provider
  rows, and the log computes `No data` on a run that already created a file and returned a URL.
- `ExportedOn eq null` — the double-handover guard (§12), dropped when `ReExport` is set.

> **Verify how `ne` treats a blank `RequestType`.** In CAML, `Neq` on a null value typically
> *excludes* the row — so a request with no type set would vanish from the export entirely rather
> than being reported as unmapped. `08` §6 test 4 covers it. If blanks are excluded, either make
> `RequestType` required on the list or replace the clause with an explicit allow-list of the
> provider-facing values.

`Compose inventory filter`:

```
concat('SIM_Country eq ''', variables('varCountryOData'), '''')
```

`OrderStatus eq 'Approved'` assumes the choice value is exactly `Approved` — `00` open item O2.

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

For Inventory, one message. For Requests, "nothing to export" has three distinct causes and the
admin needs to know which, so run one diagnostic query before answering.

| # | Action | Detail |
|---|---|---|
| a | `Is requests export` — Condition | `equals(variables('varExportType'),'Requests')` |
| a1 | ↳ `Get requests diagnostic` | Order List, filter `CountryName eq '@{variables('varCountryOData')}' and OrderStatus eq 'Approved'`, Top 5000, view limited to `ID`, `RequestType`, `ExportedOn` |
| a2 | ↳ `Filter array delegate` | from `body('Get_requests_diagnostic')?['value']` where `equals(item()?['RequestType']?['Value'],'Delegate')` |
| a3 | ↳ `Filter array exported` | where `not(equals(item()?['ExportedOn'],null))` |
| a4 | ↳ `Set varMessage requests none` | expression below |
| b | `Set varMessage inventory none` *(else branch)* | `concat('No SIMs found for ', variables('varCountry'), '.')` |
| c | `Set varStatus no data` | `No data` |
| d | `Has log item no data` — Condition on `varLogItemId > 0` → `Update log item no data` | `02` Log 2 field list, Delivery `None` |
| e | `Respond no data` | §15 |
| f | `Set varResponded no data` | `true` |
| g | `Terminate no data` | status **`Succeeded`** |

```
if(equals(length(body('Get_requests_diagnostic')?['value']),0),
   concat('No approved requests for ', variables('varCountry'), '.'),
if(equals(length(body('Filter_array_exported')),length(body('Get_requests_diagnostic')?['value'])),
   concat('All ', length(body('Get_requests_diagnostic')?['value']), ' approved requests for ', variables('varCountry'), ' were already sent to the provider. Use Re-export if the provider needs the file again.'),
if(equals(length(body('Filter_array_delegate')),length(body('Get_requests_diagnostic')?['value'])),
   concat(length(body('Filter_array_delegate')), ' approved requests for ', variables('varCountry'), ', none require provider action.'),
   concat('Nothing new to send for ', variables('varCountry'), ' — ', length(body('Filter_array_exported')), ' already sent, ', length(body('Filter_array_delegate')), ' are Delegate.'))))

```

**The diagnostic is informational and capped at 5,000.** It exists to phrase a message, not to
drive a decision. A country with more than 5,000 approved requests will produce a count that
undercounts; that is acceptable for a sentence and unacceptable for a filter, which is why the
real filter (§10.3) is the one that is paginated and indexed.

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
| `Set varFileUrl` | `body('Create_export_file')?['{Link}']` |

**Take the URL from the connector, never build it.** `{Link}` is the absolute, correctly-encoded
URL. A hand-built path breaks the day someone renames the library, or on any character needing
encoding beyond a space — and a library's *URL* often differs from its *display name*.

**Reference the file by `{Identifier}` in the Excel actions**, not by path. Referring to a
just-created file by path can hit a brief propagation delay and fail with "file not found" on fast
runs.

### 11.4 `Switch shape` — Switch on `variables('varExportType')`

**Case `Inventory`:** `Shape inventory` (Select over `variables('varItems')`, producing the 20
writable columns of `Table_query`), then **`Set varShaped inventory`** = `body('Shape_inventory')`.

The template's writable columns are **not contiguous**: A–S plus **U (IMEI)**. Column T and V–AC
hold the check formulas (`IsPhoneValid`, `PhoneClean`, `ICC_Check`, `IMEI_Check`, `Date_Check`,
`Status_Check`, `SIMType_Check`, `RowErrors`, `HasError`) and must be left alone — that is what
`CopyRowsIntoTable`'s `repairFormulas: true` and `columnsCsv` are for.

**Case `Requests`:** `Shape requests` (Select over `variables('varItems')`), then
**`Set varShaped requests`** = `body('Shape_requests')`. Two differently-named `Set` actions again,
for the same reason as §11.1g.

The map, using the explicit allow-list from `04_Order_List_Schema.md`:

```json
{
  "requestId":        "@{item()?['ID']}",
  "requestType":      "@{item()?['RequestType']?['Value']}",
  "country":          "@{variables('varCountry')}",
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

Six notes, each of which produces a broken workbook if missed:

- **`?['Value']` on the three Choice columns and `?['DisplayName']` on the User column are not
  optional.** Without them a Choice serialises as an object and lands in the sheet as
  `[object Object]`.
- **`VRCompatible` is a real Boolean**, so `true`/`false` reaches the provider unless converted.
- **`requestId` is a string** here, because `@{…}` interpolation coerces to text. That is
  deliberate and it must stay that way: §12.3 compares it against `varSkippedIds`, which the
  script produces as strings, and `contains()` does not match `"1201"` against `1201`. If someone
  "improves" this to `int(item()?['ID'])`, stamping silently stops excluding skipped rows.
- **`country` is new in v3.** `06` §4's `IsPhoneValid` check compares a number's prefix against
  `tblCountries[DialCode]` matched on a country column, and the handover sheets have no country of
  their own — there is one country per file. A hidden `Country` column on each sheet, populated
  from this key by header matching, keeps the inventory template's formula unchanged.
- **`currentIccid` duplicates `iccid` deliberately.** The Swap sheet has two ICCID columns and the
  script matches payload keys to table headers by name (§17), so `Current ICCID` needs a key of
  its own.
- **`New ICCID`, `EffectiveDate` and `ProviderNotes` are absent on purpose** — they are the
  provider's to fill.

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
| b | `Compose is final chunk` | expression below |
| c | `Switch script` | two cases below |
| d | `Increment varChunkOffset` | `length(outputs('Compose_chunk'))` |

**(b) `Compose is final chunk` — emits a literal string, not a boolean:**

```
if(greaterOrEquals(add(variables('varChunkOffset'), length(outputs('Compose_chunk'))),
                   length(variables('varShaped'))),
   'true', 'false')
```

The final chunk is the one after which the offset reaches the total. Two things about this to hold
onto:

- **v2's table showed `lessOrEquals`.** That is true for *every* chunk, including the first — so
  chunk 1 would finalize: `_Meta` written, empty tabs deleted, sheets protected, all before the
  rest of the data was written. Chunk 2 then writes into a protected sheet, or into a table whose
  worksheet has been deleted.
- **It emits `'true'` / `'false'` as text on purpose**, so that the payload in §17 can drop it in
  unquoted and produce a real JSON boolean. `string(true)` in Power Automate does not reliably
  produce lowercase `true`, and `"finalize":"false"` in JSON parses to the string `"false"`, which
  is **truthy** in JavaScript. That single mismatch finalizes every chunk.

**(d) increment by the actual chunk length**, not by `varChunkSize` — otherwise the last, partial
chunk overshoots and the loop's own accounting disagrees with §11.6's assertion.

**`Switch script` — case `Inventory`:**

`Run CopyRowsIntoTable` — `tableName: Table_query`, `columnsCsv`, `rows: outputs('Compose_chunk')`,
`startRowIndex: variables('varChunkOffset')`,
`totalExpectedRows: length(variables('varShaped'))`, `spareRows: 200`, `repairFormulas: true`.
**Retry policy: None.**

**`Switch script` — case `Requests`:**

| Action | Setting |
|---|---|
| `Compose requests payload` | §17 |
| `Run BuildRequestSheets` | File `body('Create_export_file')?['{Identifier}']` · `payloadJson` `@{outputs('Compose_requests_payload')}`. **Retry policy: None.** |
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
| `Parse build result` | Parse JSON over `json(variables('varBuildResult'))`, schema in §17 |
| `Set varRowsExported requests` | `body('Parse_build_result')?['cumulativeRows']` |
| `Set varRowsSkipped requests` | `length(body('Parse_build_result')?['skipped'])` |
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

**Unmapped and incomplete rows are reported, not shipped.** v1 put them in tabs inside the workbook
the provider receives — a provider opening `Needs attention` either actions those requests anyway
or emails to ask. `01` §4's goal is met by keeping them out of the file and putting them here, in
the response message, the email and the log's `Notes`.

### 11.7a `Nothing was written` — Condition, Requests only

```
and(equals(variables('varExportType'),'Requests'), equals(variables('varRowsExported'), 0))
```

**If true**, in order:

| # | Action | Value |
|---|---|---|
| a | `Set varStatus nothing written` | `No data` |
| b | `Set varMessage nothing written` | expression below |
| c | `Delete empty export file` | SharePoint Delete file · `body('Create_export_file')?['{Identifier}']` |
| d | `Set varFileCreated false` | `false` |
| e | `Set varFileUrl empty` | *(empty string)* |
| f | `Has log item nothing written` — Condition on `varLogItemId > 0` → `Update log item nothing written` | `02` Log 2 field list, Delivery `None` |
| g | `Respond nothing written` | §15 |
| h | `Set varResponded nothing written` | `true` |
| i | `Terminate nothing written` | status **`Succeeded`** |

```
concat('Nothing could be sent for ', variables('varCountry'), '. All ',
       variables('varRowsSkipped'), ' approved request(s) were rejected before handover. ',
       variables('varNotes'))
```

**Why this path has to exist.** The probe found rows, so a file was created, but the script routed
every one of them to `skipped` — all unmapped, or all missing a mandatory field. The workbook now
contains nothing but the Instructions sheet, because the finalize step deleted every empty tab.
v2 would have set `Rows_Exported = 0`, logged `No data`, and still returned a link to that file
with the message "Export ready: 0 rows". Deleting the file and saying what actually happened is
the only useful behaviour.

The requests are left unstamped, so once the data is fixed the next export picks them up.

### 11.8 Delivery URLs

| Action | Value |
|---|---|
| `Create sharing link` | SharePoint · File Identifier `body('Create_export_file')?['{Identifier}']` · Link type **View** · Scope **Organization**. *Configure run after* on the next action includes **has failed** |
| `Set varShareUrl` | `coalesce(body('Create_sharing_link')?['link']?['webUrl'], '')` |
| `Compose download url` | `concat(parameters('simri_SiteUrl'), '/_layouts/15/download.aspx?SourceUrl=', encodeUriComponent(body('Create_export_file')?['{Path}']))` |
| `Set varDownloadUrl` | `outputs('Compose_download_url')` |
| `Set varStatus completed` | `Completed` |
| `Set varMessage ready` | `@{concat('Export ready: ', variables('varRowsExported'), ' rows. ', variables('varSheetBreakdown'))}` |

**`Create sharing link` answers the delivery question `00` left open.** The link carries its own
access grant, so library permissions stop mattering — and a permissions gap was the whole reason
`download.aspx` surfaced as an uncatchable browser error.

**It must not be able to fail the export.** Organisation-scoped link creation can be blocked by a
tenant sharing policy, and a policy change must not destroy an export whose file is already built
and whose rows are about to be stamped. Set the run-after so the flow continues, `coalesce` the
result to empty, and let `varDownloadUrl` carry the delivery. `08` §6 test 9 covers this.

**Scope Organization, not Anyone**: the file contains employee names and delivery addresses. And
note what that means in practice — **the provider cannot open this link.** It is for the admin,
who downloads the workbook and forwards the file itself. See `09` §3 before anyone puts this URL
in an email to a supplier.

---

## 12. Stamping — preventing the double handover

Requests only, and only when rows actually reached a provider sheet. This is `01` §1, and it is
the only failure in the whole design that costs real money.

**Why stamp rather than transition `OrderStatus`.** A status transition means extending the choice
column and hunting down every view, filter and flow that keys on `Approved` — including ones you
don't own. Two additive columns break nothing, and `ExportRunId` does double duty as the key the
return-leg import needs and as the key §16.6 uses to undo a partial stamp.

**Why `$batch` rather than `Apply to each`.** `SharePoint — Update item` is one API call per row
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

Set it **once**, here — not inside the loop. `utcNow()` in a loop drifts, and every request in one
handover should carry one timestamp. That is what makes "this batch went out together" answerable
later, and it is what lets §16.6 identify exactly which rows this run stamped.

### 12.3 `Filter array stampable`

From `variables('varShaped')`, advanced condition:

```
@not(contains(variables('varSkippedIds'), item()?['requestId']))
```

Rows the script routed to unmapped or incomplete were never sent, so they must stay unstamped and
be picked up by the next export.

Both sides of this comparison are **strings** — `varSkippedIds` because the script emits
`String(id)`, and `requestId` because `@{…}` interpolation coerces. `contains()` on an array is an
exact match, so a type change on either side silently stops excluding anything.

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
'PATCH ', parameters('simri_SiteUrl'), '/_api/web/lists(guid''', parameters('simri_OrderListId'), ''')/items(', item(), ') HTTP/1.1', decodeUriComponent('%0D%0A'),
'Content-Type: application/json;odata=nometadata', decodeUriComponent('%0D%0A'),
'Accept: application/json;odata=nometadata', decodeUriComponent('%0D%0A'),
'IF-MATCH: *', decodeUriComponent('%0D%0A%0D%0A'),
'{"ExportedOn":"', variables('varStampUtc'), '","ExportRunId":"', variables('varRunId'), '"}', decodeUriComponent('%0D%0A')
)}
```

`decodeUriComponent('%0D%0A')` is how you get a literal CRLF into a Power Automate expression. The
`$batch` MIME parser is strict about line endings — a bare LF is rejected — and typing a real
newline into the designer is unreliable. That idiom is the reason the expression looks the way it
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
| Site Address | `@{parameters('simri_SiteUrl')}` |
| Method | `POST` |
| Uri | `_api/$batch` |
| Headers | `Content-Type` : `@{concat('multipart/mixed; boundary="batch_', outputs('Compose_batch_id'), '"')}` |
| | `Accept` : `application/json;odata=nometadata` |
| Body | `@{outputs('Compose_batch_body')}` |
| Settings → Retry Policy | **Exponential · Count 4 · Interval `PT10S`** — see below |
| Settings → Timeout | *(leave blank — default)* |

The connector handles the form digest for you. The boundary in the header must match the one in
the body exactly, which is why both come from the same Compose. Put the Body expression in
directly — do not wrap it in quotes, or the connector sends a JSON string rather than a multipart
document.

> **Retry here, and *only* here among the write actions.** The two Run script actions are Retry
> **None** because a retry after a partial write duplicates rows. This one is different, and the
> difference is idempotency: the PATCH body is `{"ExportedOn": <varStampUtc>, "ExportRunId":
> <varRunId>}`, both set **once per run** (§12.2), so re-sending the same batch writes the same two
> values to the same rows. Doing it twice is indistinguishable from doing it once.
>
> That matters because SharePoint throttling (429) on batch 7 of 20 is a realistic event. With
> Retry None it fails the export, triggers §16.6's compensation and makes the admin re-run for a
> transient error. With Exponential/4 it is absorbed. `varStampedCount` increments *after* a
> successful call, so a retried-then-succeeded batch still counts once.
>
> The same reasoning and the same policy apply to §16.6's unstamp batch, which PATCHes both fields
> to `null`.

> `Send an HTTP request to SharePoint` is a high-privilege action and is blocked by DLP policy in
> some tenants. Confirm it is permitted before you build (`08` §3). If it is not, the fallback is
> `Apply to each` with `Update item`, concurrency 4–8, and `varThreshold` lowered to about 300 —
> the sync path cannot absorb 2,000 sequential item updates.

**(g) `Check batch response`** — a `$batch` call returns **HTTP 200 even when individual operations
inside it failed**. Without this check, stamping silently does nothing and the double handover you
built all this to prevent happens anyway.

Condition:

```
or(contains(string(body('Send_stamp_batch')), 'HTTP/1.1 4'),
   contains(string(body('Send_stamp_batch')), 'HTTP/1.1 5'))
```

A successful PATCH returns `HTTP/1.1 204`, which matches neither pattern.

**If true** → `Set varMessage stamp failed` naming the offset, then `Force failure stamp` (Compose,
`@{div(1,0)}`) to route into the catch. A file that was built but whose rows weren't stamped must
not be delivered — the next export would send them again. §16.6 then undoes the rows that *were*
stamped before the failure.

> Verify on the first run where the connector puts a multipart response — `body('Send_stamp_batch')`
> or `outputs('Send_stamp_batch')?['body']`. `08` §6 test 6 says to read one raw response by hand
> before trusting the parser, which is the same advice the import spec gives for the same reason.

### 12.6 `Set varNotes stamped`

**`Append to string variable`** on `varNotes`:

```
@{concat(' | Stamped ', variables('varStampedCount'), ' request(s) with RunId ', variables('varRunId'), if(variables('varReExport'),' (RE-EXPORT)',''))}
```

Use `Append to string variable`, not a `Set variable` that references itself. The import flow does
the same, and a self-referencing `Set` has documented ordering hazards the append does not.

---

## 13. `Read upload gate` — free data-quality reporting

Inventory only, inside a condition on `equals(variables('varExportType'),'Inventory')`, placed
after §11.6 and before §11.7. The template already computes everything needed and v2's flow
ignored it.

`Config!J2` is the named range **`UploadGate`**:
`=IF(COUNTIF(Table_query[HasError],"ERROR")=0,"OK","BLOCKED")`, with `UploadGate_ErrorCount` at
`J3`. Because both use structured references over `Table_query`, they cover every written row —
unlike the conditional formatting, which stops at row 1966 (see `06_Handover_Template_Spec.md`).

Add a small Office Script `ReadUploadGate` returning `{ "gate": "OK|BLOCKED", "errorCount": n }` as
a JSON string, then:

| Action | Setting |
|---|---|
| `Run ReadUploadGate` | Excel Run script · File `body('Create_export_file')?['{Identifier}']` · Retry **None** · *run after* on the next action includes **has failed** |
| `Set varDataErrors` | `int(coalesce(json(body('Run_ReadUploadGate')?['result'])?['errorCount'], 0))` |
| `Append varNotes data errors` | **Append to string variable** on `varNotes`, expression below |

```
@{if(greater(variables('varDataErrors'),0),
     concat(' | ', variables('varDataErrors'), ' exported row(s) fail validation — see the RowErrors column.'),
     '')}
```

This costs one script call and turns every inventory export into a data-quality audit of that
country's estate, using the Luhn checks, dial-code checks and date checks already built and tested
in the template. **Do not block on it** — the export is a read, and the admin may be exporting
precisely because they want to see the bad rows. For the same reason it must not be able to fail
the run: continue on failure and report zero.

---

## 14. `Was async` — respond or email

```
equals(variables('varAsync'), true)
```

- **If TRUE** → `Send export email` to `variables('varActionedBy')` with `varShareUrl` (falling
  back to `varDownloadUrl` when empty) as a **link**, never an attachment. A 60,000-row workbook is
  around 28 MB against Outlook's ~25 MB cap. Style it on the import emails in
  `../SIM Inventory/Email_Templates.md`. Include `varSheetBreakdown` and `varNotes` — the
  skipped-request list is the part the admin must act on.
- **If FALSE** → `Respond ready` (§15), then `Set varResponded ready` = `true`.

Exactly one `Respond to a PowerApp` executes on every path: `Respond invalid`,
`Respond unauthorised`, `Respond claim rejected`, `Respond no data`, `Respond nothing written`,
`Respond queued` or `Respond ready`.

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

`Delivery` comes from `varAsync`, not from a row count. The async decision was made on the **probe
count**; rows written is lower after Delegate and skipped rows come out. A probe of 2,100 that
writes 1,950 would have logged "Link returned" for a run that emailed — misreporting exactly at the
boundary the field exists to help you tune.

`varShareUrl` goes to the email (§14) and the response (§15), not to the log — the sharing link is
a delivery artefact, and `{Link}` is the stable address of the file itself.

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
        Trim(drpCountry.Selected.Value), "Requests", User().Email, tglReExport.Value)),
    Set(gblExport, {status: "Failed",
                    message: "The export could not be started. Please try again, and tell IT if it keeps happening.",
                    fileUrl: "", shareUrl: "", rows: 0})
);
UpdateContext({locBusy: false});
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
| 16.6 | `Was anything stamped` — Condition `greater(variables('varStampedCount'), 0)` → the compensation below | |
| 16.7 | `Terminate failed` | Status `Failed` |

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
  chain matters. Falling back to `varMessage` also carries §11.6's and §12.5's deliberate-failure
  messages through to the log.

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

### 16.6 `Undo partial stamps` — the compensation

Runs only when `varStampedCount > 0`. Without it, the worst failure in the design is still
reachable: §12.5 fails on batch 7 of 20, the file is deleted, and 600 requests are marked as handed
over to a provider that never received them. They will never appear in another export, and nobody
will know until an employee asks where their SIM is.

Because §12.2 stamps one `ExportRunId` for the whole run, the rows to undo are exactly identifiable:

| # | Action | Detail |
|---|---|---|
| a | `Get stamped rows` | `Get items` on the Order List · Filter `ExportRunId eq '@{variables('varRunId')}'` · Top 5000 · Pagination ON · view limited to `ID` |
| b | `Select unstamp ids` | from `body('Get_stamped_rows')?['value']`, text mode, `@{item()?['ID']}` |
| c | `Do until unstamp batches` | same shape as §12.5, with the PATCH body `{"ExportedOn":null,"ExportRunId":null}` |
| d | `Append varNotes compensated` | `@{concat(' | COMPENSATION: cleared the export stamp from ', length(body('Select_unstamp_ids')), ' request(s) after a stamping failure. They will be picked up by the next export.')}` |

Set *Configure run after* on each so a compensation failure still reaches `Terminate failed` —
but if (c) fails, the note in (d) will not be written, so **also** log the RunId in the failure
email. A compensation that fails is a manual cleanup, and the person doing it needs one filter:
`ExportRunId eq '<runId>'`.

> The window between the first successful batch and the compensation is small but real. If the flow
> is cancelled by an administrator in that window, neither the catch nor the compensation runs. The
> "Stuck runs" view plus `ExportRunId` is the manual recovery path, and `08` §7 documents it as a
> runbook step rather than leaving it to be rediscovered.

---

## 17. `BuildRequestSheets` — payload and result

Full script in `BuildRequestSheets.ts`. Template requirements in `06_Handover_Template_Spec.md`.

### Building the payload — `Compose requests payload`

The script's parameter is a **string** that it `JSON.parse`s, so the flow must produce valid JSON
text with the right JSON *types*. Build it exactly like the import flow does
(`../SIM Inventory/Import_Flow_Spec.md` §5a) — `string(json(concat(…)))`, with numbers and
booleans left unquoted:

```
string(json(concat('{
 "runId":"', variables('varRunId'), '",
 "country":"', variables('varCountry'), '",
 "actionedBy":"', variables('varActionedBy'), '",
 "exportedUtc":"', variables('varStartedUtc'), '",
 "startRowIndex":', variables('varChunkOffset'), ',
 "totalExpectedRows":', length(variables('varShaped')), ',
 "finalize":', outputs('Compose_is_final_chunk'), ',
 "rowKeyHeader":"RequestID",
 "textHeaders":', string(outputs('Compose_text_headers')), ',
 "typeMap":', string(outputs('Compose_type_map')), ',
 "requests":', string(outputs('Compose_chunk')), '
}')))
```

**The `json()` wrapper is not decoration.** It parses the string, which means a malformed payload
fails *here*, in an action whose name tells you what went wrong, rather than inside the Office
Script as a `JSON.parse` error 500 characters into a blob.

**Why the types matter more than they look:**

- `"startRowIndex":"0"` reaches the script as the string `"0"`. `p.startRowIndex === 0` is then
  `false`, so **`assertTemplate()` never runs** — and that is the guard that refuses to write when
  an ICCID column has lost its Text format. The export succeeds and quietly truncates every ICCID
  past the 15th digit.
- `"finalize":"false"` reaches the script as the string `"false"`, and **every non-empty string is
  truthy in JavaScript**. Every chunk finalizes: sheets protected and empty tabs deleted after
  chunk 1.

`Compose is final chunk` (§11.5b) emits the bare text `true` or `false` precisely so it can sit
unquoted here. The script also coerces both values defensively, but do not rely on that — a payload
with the wrong types is wrong for the next person too.

`Compose text headers` and `Compose type map` are two root-level Composes, defined once alongside
§5 and §6 so the loop does not rebuild them 120 times.

**`Compose text headers`:**

```json
["PhoneNr","ICCID","Current ICCID","New ICCID","StartDate","EffectiveDate","GDID","simInventoryID"]
```

**`Compose type map`** — `type` values must match the Order List's `RequestType` choice values
exactly (`00` open item O1); `sheet` and `table` must match the handover template:

```json
[
  { "type": "New SIM",     "sheet": "New SIM",     "table": "tbl_NewSIM",
    "required": ["gdid","requestedFor","provider","deliveryAddress"],
    "blankHeaders": ["PhoneNr","ICCID","StartDate"] },
  { "type": "Terminate",   "sheet": "Terminate",   "table": "tbl_Terminate",
    "required": ["gdid","requestedFor","provider","phoneNr"],
    "blankHeaders": [] },
  { "type": "Swap",        "sheet": "Swap",        "table": "tbl_Swap",
    "required": ["gdid","requestedFor","provider","iccid","newSimType"],
    "blankHeaders": [] },
  { "type": "Transfer",    "sheet": "Transfer",    "table": "tbl_Transfer",
    "required": ["gdid","requestedFor","provider","phoneNr","transferdTo"],
    "blankHeaders": [] },
  { "type": "Change plan", "sheet": "Change plan", "table": "tbl_ChangePlan",
    "required": ["gdid","requestedFor","provider","phoneNr","newPlan"],
    "blankHeaders": [] }
]
```

**`blankHeaders`** is new in v3. On the New SIM sheet, `PhoneNr`, `ICCID` and `StartDate` are the
provider's to fill — but the payload carries keys of the same name, so header matching would
pre-fill them with whatever the Order List happens to hold. Listing them here forces those columns
blank on that sheet only. Making it a deliberate list rather than an accident of which fields are
usually empty is the point.

**No column lists in the payload.** The script reads each table's header row from the template and
matches headers to payload keys by normalised name (`Current ICCID` → `currenticcid`). Add a column
to the template and it populates itself if a matching key exists, or stays blank if not — and the
blank ones come back in `unfilledHeaders` so you can confirm they are the intended fill-in columns.
This removes the entire class of "the script's column list drifted from the template" bug, and it
means `Delegate`'s absence is enforced by there being no tab for it.

**Columns with no matching payload key are never written.** That is what protects the check
formulas. See §17's "What the script writes" below — it is the single most important behaviour in
the script and v2 got it wrong.

### What the script writes — and what it must not touch

The script follows the same pattern as the production `CopyRowsIntoTable`, for the same reason:

1. Headers whose normalised name matches a payload key are **data columns** — written.
2. Every other header is left **untouched**. That covers the check formula columns (`ICC_Check`,
   `Date_Check`, `RowErrors`, `HasError`, …) and the provider fill-in columns
   (`New ICCID`, `EffectiveDate`, `ProviderNotes`).
3. After writing, formula columns are re-filled down from the template's prototype row using
   `autoFill(fillCopy)`, which adjusts relative references exactly as dragging the fill handle
   would.

v2's script built a full-width array and wrote `""` into every column without a payload key. One
export and every check formula in the provider workbook is replaced by a literal empty string.
Excel does not restore it. Nothing turns red, nothing errors, and the file looks fine — which is
why it would have survived testing.

This is also why `06` requires each table to ship with **exactly one prototype data row** holding
the check formulas: `autoFill` needs a source row, and a table with zero rows has none.

### Returns

A JSON string — dynamic keys can't be schema'd, same as the import script:

```json
{
  "rowsWritten": 500,
  "cumulativeRows": 2380,
  "breakdown": [{ "sheet": "New SIM", "rows": 1840 }],
  "breakdownText": "New SIM: 1840 · Terminate: 420 · Swap: 120",
  "skippedIds": ["1201", "1355"],
  "skipped": [
    { "id": "1201", "reason": "unmapped:Upgrade device" },
    { "id": "1355", "reason": "missing:phoneNr,newPlan" }
  ],
  "unfilledHeaders": ["New ICCID", "EffectiveDate", "ProviderNotes"],
  "finalized": true
}
```

**IDs are strings**, everywhere, on both sides. §12.3 depends on it.

**`cumulativeRows` is counted from the workbook**, not accumulated in the flow — the script has no
memory between chunk invocations, so counting the filled `RequestID` cells is the only number that
cannot drift.

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

**There are no `Apply to each` actions in this flow at all.** That is deliberate — §11.5 and §12.5
are `Do until` loops over offsets, and shaping is done by a single `Select` rather than a loop.
The only place a concurrency setting would ever appear is the `Apply to each` fallback in §12.5's
DLP note, and that one is sequential-then-4-to-8 by design.

### Retry policy — the default is wrong in three places

**Every connector action defaults to Exponential, Count 4.** You only change it where a retry is
unsafe:

| Action | Retry | Why |
|---|---|---|
| `Create log item` §8 | Exponential · 4 · PT10S | write to our own log; a duplicate row is impossible because it returns the ID we then reuse |
| All `Update log item …` | Exponential · 4 · PT10S | idempotent — writes the same field values |
| `Check authorisation` §10.2, `Claim concurrency` §10.2b | Exponential · 4 · PT10S | reads |
| `Get inventory/requests probe` §10.4, `… full` §11.1g, `Get requests diagnostic` §10.6 | Exponential · 4 · PT10S | reads |
| `Get template` §11.3 | Exponential · 4 · PT10S | read |
| `Create export file` §11.3 | Exponential · 4 · PT10S | the filename carries the RunId, so a retry overwrites the same file rather than making a second one |
| **`Run CopyRowsIntoTable` §11.5** | **None** | a script that times out at 120s *after* writing rows would be retried, and the rows written again |
| **`Run BuildRequestSheets` §11.5** | **None** | same |
| **`Run ReadUploadGate` §13** | **None** | same class of action; and it must not be able to fail the run at all |
| `Send stamp batch` §12.5 | Exponential · 4 · PT10S | **idempotent** — the PATCH body is fixed for the whole run, so re-sending writes the same two values. See §12.5(f) |
| `Send unstamp batch` §16.6 | Exponential · 4 · PT10S | idempotent — PATCHes both fields to `null` |
| `Create sharing link` §11.8 | None | it is allowed to fail; the flow falls back to the download URL |
| `Delete partial file` §16.5, `Delete empty export file` §11.7a | None | a 404 on retry is noise; best-effort by design |
| `Send export email` §14, `Send failure email` §16.4 | Exponential · 4 · PT10S | a duplicate email is better than a missing one |

### Timeout

**Leave every action timeout blank.** The defaults are correct for this flow, and the two limits
that actually bind are not action timeouts:

| Real limit | Value | Where it bites |
|---|---|---|
| PowerApps flow call | ~120 seconds | the whole sync path — `varThreshold` exists to stay under it |
| Excel Online **Run script** | 120 seconds, hard | why §11.5 chunks at all. An action timeout cannot raise it |
| `Do until write chunks` §11.5 | **Count `5000` · Timeout `PT2H`** | must be set — defaults are Count 60 / PT1H and the loop **exits normally** at the cap |
| `Do until stamp batches` §12.5 | **Count `5000` · Timeout `PT1H`** | must be set, same reason |
| `Do until unstamp batches` §16.6 | **Count `5000` · Timeout `PT1H`** | must be set, same reason |

The three `Do until` limits are the only timeouts you type in this flow. Everything else is default.

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
it — and it would queue inventory exports behind requests exports for no benefit. §10.2b's soft
claim does the job, is reversible, and names the run that blocked you.

---

## 18. Path summary

| Path | Reads | Writes | File | Response | Typical |
|---|---|---|---|---|---|
| Invalid input | 0 | 1 log | none | immediate | < 2s |
| Not authorised | 1 | 1 log | none | immediate | < 3s |
| Claim rejected | 2 | 1 log | none | immediate | < 3s |
| No data (Inventory) | 1 probe | 1 log | none | immediate | < 3s |
| No data (Requests) | 1 probe + 1 diag | 1 log | none | immediate | < 5s |
| All requests skipped | 1 probe | 1 log + 1 delete | created, then deleted | immediate | 10–20s |
| Sync ≤ 2000 rows | 1 probe | ≤20 `$batch` + 1 log | built from `varShaped` | immediate, with URL | 20–50s |
| Async > 2000 rows | 1 probe + paged | N `$batch` + 1 log | built after responding | immediate, "we'll email it" | ~4s to respond |
| Stamping failure | 1 probe + 1 recovery | N + N `$batch` + 1 log | built, then deleted | failure message or email | 30–90s |

At 2,000 rows the sync path is four script chunks plus twenty `$batch` calls plus a sharing link.
**If real timings put that near 120 seconds, lower `varThreshold` rather than dropping the
stamping** — §12 is the only protection against the one failure that costs money. `02`'s
`DurationSeconds` column and its "Threshold tuning" view exist to make that a measured decision.

**Steady state.** Once the first export for a country is stamped, subsequent exports pick up only
newly-approved requests. The "thousands" figure is a backlog, not a recurring load — after the
first run per country, almost every export takes the sync path.

---

## 19. Monitoring

The catch scope logs and responds, but nobody watches a SharePoint list. Build the **scheduled
digest flow** in `02_Export_Log.md` §Alerting before go-live, not after the first missed failure.

The one thing an in-catch email cannot do, and the digest can: surface the runs that reached
neither terminal action. If the catch never ran, an email inside it never sends.

---

## 20. Still needed, and one thing planned for

Open items are tracked in `00_Design_Decisions.md` §Open items. Repeating the three that block
this document:

1. **The exact `RequestType` choice values** — they become the `type` keys in `typeMap` and must
   match the sheet and table names in the template. An unmatched value goes to `skipped` with
   reason `unmapped:<value>` and is left unstamped rather than lost, so a wrong guess is visible
   and recoverable.
2. **The `OrderStatus` value meaning approved** — §10.3 assumes `Approved`.
3. **Confirm `Transfer` is provider-facing and distinct from `Delegate`.**

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

The stamping, the claim and the catch all work unchanged, because they are already keyed on
country. The expensive part is that every single-file assumption becomes a collection — which is
exactly the same shape of change `06` describes for the one-provider-per-country assumption, and
for the same reason.
