# SIM Exports — build checklist, deployment and test plan

Everything that must exist **before** you open the flow designer, how the solution moves between
environments, and the order to test in.

`03_Export_Flow_Spec.md` assumes all of §1–§4 below is already done. Building the flow first and
the prerequisites second is how you spend an afternoon debugging a connector error that turns out
to be a missing index.

---

## 1. SharePoint objects

### 1.1 Global Order List — four new columns

Create with plain names, rename afterwards, then verify the internal names.

| Create as | Rename to | Type |
|---|---|---|
| `ExportedOn` | ExportedOn | Date and Time |
| `ExportRunId` | ExportRunId | Single line of text |
| `EffectiveDate` | EffectiveDate | Single line of text |
| `ProviderNotes` | ProviderNotes | Multiple lines, **plain text** |

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$select=InternalName,Title&$filter=Hidden eq false
```

**Check for `_x005f_` in the internal names.** SharePoint sometimes encodes an underscore
depending on how the column was created, so `ExportRunId` can come back as `Export_x005f_RunId`.
It writes nothing and errors nowhere — the same failure mode as `Request_x0020_Type`.

`EffectiveDate` and `ProviderNotes` are for the **return leg**. This flow never writes them. They
are created now because the handover template's columns must map to something, and adding them
later means asking providers to switch format.

### 1.2 Indexes

| List | Indexed columns |
|---|---|
| Global SIM Inventory | `SIM_Country` |
| Global Order List | `CountryName`, `OrderStatus`, `ExportedOn` |
| SIM Export Log | `RunId`, `Status`, `Country`, `ExportType` |

If a single country can exceed 5,000 rows in the Order List, add a **compound index** on
`CountryName` + `OrderStatus`. The leading filter clause must narrow below 5,000 or the query is
throttled regardless of what follows it.

### 1.3 SIM Export Log list

Full schema in `02_Export_Log.md`. Create it, verify internal names with the same query pattern,
set permissions to **read for users, write for the flow's connection identity**, turn versioning
**off**, and create the eight views listed there.

Check the `Status` choice column has all **seven** values: `Running`, `Queued`, `Completed`,
`No data`, `Unauthorised`, `Invalid`, `Failed`. SharePoint rejects a value that isn't in the list,
and the flow writes all seven.

### 1.4 SIMRI Country Matrix — nothing to build

`03` §10.2 authorises against this list and **it already exists**: GUID
`29bf3303-c195-474f-9146-e25d9f0d1b77`, one row per country, holding the provider, plan, delivery
defaults and the local admins. Full schema in `11_Country_Matrix_Schema.md`.

Earlier drafts of this checklist described building a separate `Country Admins` list. Do not — a
second source of truth for who administers a country is a bug waiting to happen, and this one is
already what the app maintains.

Three things to verify rather than create:

- **The internal names.** `field_1` is CountryName; `field_13`, `field_14`, `field_15` are Local
  Admin 1, Local Admin 2 and Local Admin Group. Ten columns on this list are `field_N` and none of
  them can be inferred from the display name. `LinkTitle` displays as *CountryCode* but is a
  computed field and **cannot be filtered** — the value is in `Title`.
- **What `field_15` actually holds** for a country that uses it. It is a text column, so §10.2
  compares it to the caller's own address. A shared mailbox someone signs in as works; a
  distribution list or AAD group does not, and a member of it would be told they are not authorised.
- **That `field_1` matches `CountryName` on the Order List** and `SIM_Country` on the Inventory,
  exactly. A mismatch produces a clean "not authorised" or a clean "no approved requests" — a
  correct-looking answer to a question nobody asked.

No index required: one row per country is far below the 5,000 threshold.

### 1.5 The two "Limit Columns by View" views

`03` §10.4 depends on these. A column that is in the export map but not in the view **exports
empty and errors nowhere**.

| View | On | Must contain |
|---|---|---|
| `FlowExport_Inventory` | Global SIM Inventory | `ID` plus the 20 writable columns of `Table_query` |
| `FlowExport_Requests` | Global Order List | `ID`, `RequestType`, `GDID`, `Requestedfor`, `Provider`, `Ticket_ID`, `PhoneNr`, `ICCID`, `SIMType`, `newSimType`, `PlanName`, `NewPlan`, `VRCompatible`, `DeliveryAddress`, `Location`, `simInventoryID`, `TransferdTo`, `StartDate`, `ExportedOn` |
| `FlowExport_Diagnostic` | Global Order List | `ID`, `RequestType`, `ExportedOn` |

**`ID` in every one of them.** It is not returned automatically when column limiting is on.
Without it `item()?['ID']` is null, which means a blank `RequestID` column in the provider's
workbook and an empty stamp list — the export appears to work and prevents nothing.

Note `FlowExport_Requests` deliberately excludes `WorkHistory`, `ApprovalPlanJson`,
`Justification` and `LineManager`. The Select map is the primary allow-list; the view is the second
one, and the reason both exist is in `09` §1.

### 1.6 The output library

Create `/SIM Exports/Files` as a document library. Apply the retention policy from `09` §2 at the
same time, not later — retrofitting retention across a library of several thousand files is a
different job.

### 1.7 Templates

| File | Action |
|---|---|
| `SIM_Data_Validation_DEMO.xlsx` | rename to `SIM_Inventory_TEMPLATE.xlsx`; keep the sample-row copy elsewhere. **Check first whether admins link to the old name** as their upload template for the import process |
| `SIM_Request_Handover_TEMPLATE.xlsx` | build to `06_Handover_Template_Spec.md`, then run the pre-ship checks in its §7 |

---

## 2. Environment variables

`03` references these instead of hard-coding values, so the solution can be promoted without
hand-editing expressions. Create them **inside the solution**, with the value set as the *current
value* per environment.

| Name | Type | PROD value |
|---|---|---|
| `simri_SiteUrl` | Text | `https://deutschebank.sharepoint.com/sites/simri` |
| `simri_InventoryListId` | Text | `6b659861-abd0-4e45-b74e-63e3f69f2648` |
| `simri_OrderListId` | Text | `e390b86b-13bb-4655-b3e6-efd5bd068279` |
| `simri_CountryMatrixId` | Text | `29bf3303-c195-474f-9146-e25d9f0d1b77` |
| `simri_ExportLibrary` | Text | `/SIM Exports/Files` |
| `simri_InventoryTemplate` | Text | `/Documents/SIM_Inventory_TEMPLATE.xlsx` |
| `simri_HandoverTemplate` | Text | `/Documents/SIM_Request_Handover_TEMPLATE.xlsx` |
| `simri_FlowEnvironmentId` | Text | the Power Platform environment GUID from the maker portal URL |
| `simri_SupportEmail` | Text | wherever the failure digest should land |

**Why this is not optional at a bank.** A flow with a site URL typed into three expressions and a
list GUID typed into a `$batch` body cannot be exported to UAT — someone edits it by hand, misses
one, and a test run writes to production data. The list GUIDs in particular appear inside a
composed HTTP body where no connector validation would catch a stale value.

If environment variables are not available to you, the minimum fallback is **one root-level Compose
per value**, referenced everywhere, so there is exactly one place to change.

---

## 3. Connections, identity and DLP

| Check | Why |
|---|---|
| The flow's SharePoint connection runs as a **service account**, not a named person | when that person leaves, every export stops, and the log's audit trail suddenly attributes writes to a disabled account |
| That account has **write** on `/SIM Exports/Files`, **write** on the Order List, **write** on SIM Export Log, **read** on both templates | least privilege; it does not need site collection admin |
| The Outlook connection's mailbox is documented | the async email's From address is the first thing an admin asks about |
| `Send an HTTP request to SharePoint` is permitted by DLP | §12 stamping is built on it. It is blocked in some tenants as a high-privilege action |
| SharePoint + Excel Online + Outlook are in the same DLP data group | a policy that separates them blocks the flow from saving at all, with an error that does not say so clearly |
| Organisation-scoped sharing links are permitted | `03` §11.8. If not, the flow still works — it falls back to the download URL — but confirm before go-live rather than discovering it in the first failure |

**If `Send an HTTP request to SharePoint` is blocked**, the fallback is `Apply to each` with
`Update item`, concurrency 4–8, and `varThreshold` lowered to about 300. Record the change in
`00`; do not silently drop the stamping, which is the only protection against the one failure that
costs money.

---

## 4. Office Scripts

Both scripts must be saved in a location the flow's connection can reach — the connection owner's
OneDrive, or a SharePoint library shared with them. A script saved in a developer's personal
OneDrive is a production dependency on that developer's account.

| Script | Status |
|---|---|
| `CopyRowsIntoTable` | existing, production, unchanged |
| `BuildRequestSheets` | new — `BuildRequestSheets.ts` in this folder |
| `ReadUploadGate` | new, small — `03` §13. Returns `{"gate":"OK\|BLOCKED","errorCount":n}` as a JSON string |

---

## 5. Build order

The spec is written in build order and every action is defined before it is referenced, so working
top to bottom works. Two departures worth making:

1. **Build and test the Inventory path end to end first.** It has no stamping, no `$batch`, no
   handover template and no return leg. Everything shared — trigger, variables, logging, the
   sync/async split, the catch scope, the response contract — gets exercised by the simpler branch.
2. **Add the Requests branch second**, and add §12 stamping *last*, after the Requests path
   produces a correct workbook. Stamping is the part that writes to production data; do not have it
   running while the thing that decides *what* to stamp is still being debugged.

---

## 6. Test plan

In order. Each test is written so a failure tells you which assumption was wrong.

### Wiring

**1. Parameter order.** Run once from PowerApps with four distinguishable values. In the run
history, confirm `text` is Country, `text_1` is ExportType, `text_2` is ActionedBy. Crossed
suffixes are the single most likely early mistake and produce a filter for a country called
`Requests`.

**2. `Create log item` returns `ID`, not `Id`.** Expand the action's Outputs and read the property
name. If `varLogItemId` stays 0, every log write is skipped by its own guard, the export works
perfectly and logs nothing.

**3. Invalid input.** Empty country. Expect: response with `status = Invalid` and a message naming
what was missing, one log item at `Invalid`, run history status `Cancelled`, **no file**. Then
repeat with a country of a single space — `empty(' ')` is `false` and this is the test that proves
§2's trim is doing its job.

**4. Unauthorised.** A country the caller does not administer. Expect `status = Unauthorised`, a
log item at `Unauthorised` recording **both** the email and the country attempted.

Then three variants, because this filter has more ways to be wrong than it looks:

- `ActionedBy` set to `x' or field_1 ne '` — must be rejected, not authorised. That is §4a's
  escaping doing its job.
- An admin who is Local Admin 2 for country A, exporting country B. **Must be rejected.** If it
  passes, the parentheses are missing from §10.2's filter and every admin can export every country.
- The same email in different casing. Should still pass — SharePoint text comparison is
  case-insensitive — but confirm it, because `User().Email` casing varies by tenant.

### Inventory path

**5. Small inventory export, ~20 rows.** Expect a file, a working sharing link, `Delivery = Link
returned`, `DurationSeconds` populated. Open the workbook and confirm the check columns still hold
**formulas**, not values — `RowErrors` and `HasError` computing on every row is the thing v2's
script destroyed.

**6. `Limit Columns by View`.** Deliberately remove one exported column from
`FlowExport_Inventory` and re-run. The column must export empty — confirm you can see that, because
in production this failure produces no error at all. Put the column back.

**7. A country with no SIMs.** Expect **no file**, `status = No data`, a clear message, a log item
at `No data`, and run history status `Succeeded`.

**8. Full volume, 60,000 rows.** The one that cannot be skipped. Confirm:
- the `Do until` limits are Count 5000 / PT2H, **not** the defaults — at 500 per chunk this is 120
  iterations and the default cap of 60 exits *normally*, shipping a half-empty file that looks fine
- `varChunkOffset` equals the shaped row count at the end, and §11.6's assertion passes
- the row count in the workbook equals the row count in the log
- how long it actually takes, and where the time goes. If `take(skip(varShaped, …), …)` over a
  large array dominates, `03` §11.1's note names the fallback

### Requests path

**9. Three requests, one of each type.** Confirm each lands on the right sheet, the identity block
is populated, the fill-in columns are empty, and the two ICCID columns on Swap are the right way
round. Then confirm the sheets for the two types with no rows have been **deleted**.

**10. An ICCID with 20 digits.** Type one into the template by hand before shipping it, and check
one in a generated file. If it displays as `8.94001E+18` or ends in zeros, the column is not
Text-formatted and `assertTemplate` should have refused to run — which is itself the bug.

**11. A request with a `RequestType` that is not in `typeMap`.** Expect: not in the workbook, in
`skipped` as `unmapped:<value>`, named in the response message and the log's `Notes`,
`Rows_Skipped` incremented, and **`ExportedOn` still empty on that row** so the next export picks
it up.

**12. A request missing a mandatory field.** Same expectations, reason `missing:<fields>`.

**13. Every request invalid.** All rows unmapped or incomplete. Expect **no file left in the
library**, `status = No data`, a message saying so, and nothing stamped. This is `03` §11.7a, and
v2 would have handed back a link to a workbook containing only the Instructions sheet.

**14. Chunking.** More than `varChunkSize` requests, so at least three chunks run. Confirm:
- `finalize` is `false` on every chunk but the last — check the payload in the run history, and
  check it is the JSON literal `false`, not the string `"false"`
- sheets are protected and `_Meta` is written **once**, at the end
- no request appears twice

**15. Re-run the same export.** Must produce "All N approved requests were already sent". If it
produces another file, stamping is not working, and that is the failure that costs money.

**16. `ReExport = true`.** Must produce a file containing the same requests, with `ReExport = Yes`
on the log item.

### Stamping and failure

**17. Read one raw `$batch` response by hand** before trusting the parser — the same advice the
import spec gives, for the same reason. Confirm where the connector puts a multipart response and
that a successful PATCH shows `HTTP/1.1 204`.

**18. A `$batch` that fails.** Force it — point one PATCH at an item ID that does not exist. Expect:
the run fails, the file is deleted, and **§16.6 clears `ExportedOn` and `ExportRunId` from every row
this run had already stamped**. Then re-run the export normally and confirm those requests come
back. This is the test that proves the design is safely re-runnable, and it is the one most likely
to be skipped.

**19. Concurrency.** Two admins, same country, Requests, within seconds. Expect exactly one export
and one clear "already running" message — not two exports, and not two rejections. If both are
rejected, the `ID lt varLogItemId` clause is missing from §10.2b.

**20. Async failure.** Force a failure after `Respond queued`. Expect: no second Respond attempt,
a failure **email** to the actioning admin, a log item at `Failed` with a readable `ErrorMessage`,
and no partial file left behind. A second Respond would take the catch scope down with it and the
user would get silence.

**21. Sharing link blocked.** Temporarily deny organisation-scoped links, or point the action at a
bad identifier. The export must still complete, with `shareUrl` empty and `fileUrl` working.

### Delivery and downstream

**22. Async threshold.** An export just over `varThreshold`. Expect a response in about four
seconds, `status = Queued`, a log item at `Queued`, then an email with a **link** — never an
attachment. Confirm `Delivery = Emailed` on the final log row.

**23. Popup blocked.** Block popups in the browser and click Export. The user must still be able to
get the file from the selectable `shareUrl` label.

**24. The provider's experience.** Open a finished workbook as a provider would: fill a row, try to
edit a protected cell, try to delete a sheet, paste a column of ICCIDs. Confirm the check columns
colour correctly on typed entry, and confirm they do **not** fire on paste — that is expected, and
it is why the return-leg import must revalidate everything server-side.

**25. Read `_Meta`.** Unhide it with a script and confirm RunId, Country, ExportedBy, ExportedUtc,
RowsWritten and TotalExpectedRows are all populated and match the log row.

---

## 7. Runbook — what to do when something goes wrong

| Symptom | First thing to check | Recovery |
|---|---|---|
| Log item stuck at `Running` or `Queued` for over a day | run history for that RunId — a cancelled run or a platform timeout reaches neither terminal action | if `ExportRunId` was stamped on Order List rows, clear it manually with the filter `ExportRunId eq '<runId>'`, then re-export |
| An admin says requests never reached the provider | `Rows_Skipped` on the log row, then `Notes` for the RequestIDs and reasons | fix the data, re-export — skipped rows were never stamped |
| A request was provisioned twice | the log's "By country" view for two Requests exports close together, and `ReExport` on both | the stamp on the Order List row names the RunId that sent it |
| Every Requests export rejects itself as "already running" | `ID lt varLogItemId` missing from §10.2b's filter | fix the filter; no data damage |
| Provider's workbook has no colours and `RowErrors` is blank | check columns hold values instead of formulas | the script wrote columns it should have stepped over. Compare against `BuildRequestSheets.ts` §"v3 — what changed" |
| ICCIDs end in zeros | the column lost its `@` format and `assertTemplate` did not catch it | check the payload's `textHeaders`, then the template |
| Export works but nothing is logged | `varLogItemId` is 0 — `Create log item` failed, or `?['ID']` casing is wrong | test 2 |

Clearing a stamp by hand, for the runbook rows that need it:

```
_api/web/lists(guid'<simri_OrderListId>')/items?$filter=ExportRunId eq '<runId>'&$select=Id
```

then PATCH `{"ExportedOn":null,"ExportRunId":null}` on each. §16.6 automates exactly this; the
manual version is for the runs that never reached the catch scope at all.

---

## 8. Before go-live

- [ ] All 25 tests pass, including 8, 18 and 19
- [ ] The scheduled failure-digest flow exists and has sent one "nothing to report" email
- [ ] Retention is applied to `/SIM Exports/Files` and confirmed in the compliance record (`09`)
- [ ] `00` open items O1, O2, O3 are closed and `typeMap` matches the real choice values
- [ ] O4 — external transfer of employee data — has an answer from Data Protection, in writing
- [ ] `varThreshold` has been set from measured timings, not from 2000 being a round number
- [ ] The handover template has been through `06` §7: no web-extension reference, no personal
      document properties, no sample rows, correct filename
- [ ] The connection identity is a service account and is documented
- [ ] One local admin who was not involved in building this has run an export start to finish
      without being told how
