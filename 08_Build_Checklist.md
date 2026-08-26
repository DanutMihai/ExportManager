# SIM Exports — build checklist, deployment and test plan

Everything that must exist **before** you open the flow designer, how the solution moves between
environments, and the order to test in.

`03_Export_Flow_Spec.md` assumes all of §1–§4 below is already done. Building the flow first and
the prerequisites second is how you spend an afternoon debugging a connector error that turns out
to be a missing index.

---

## 1. SharePoint objects

### 1.1 Global Order List — nothing to add

Neither export path writes back to its source list, so there are no new columns to create here.
(If `ExportedOn`, `ExportRunId`, `EffectiveDate` or `ProviderNotes` already exist on the Order List
from earlier work, this flow simply doesn't read or write them.)

### 1.2 Indexes

| List | Indexed columns |
|---|---|
| Global SIM Inventory | `SIM_Country` |
| Global Order List | `CountryName`, `OrderStatus` |
| SIM Export Log | `RunId`, `Status`, `Country`, `ExportType` |

If a single country can exceed 5,000 rows in the Order List, add a **compound index** on
`CountryName` + `OrderStatus`. The leading filter clause must narrow below 5,000 or the query is
throttled regardless of what follows it.

### 1.3 SIM Export Log list

Full schema in `02_Export_Log.md`. Create it, verify internal names with the same query pattern,
set permissions to **read for users, write for the flow's connection identity**, turn versioning
**off**, and create the six views listed there.

Check the `Status` choice column has all **seven** values: `Running`, `Invalid`, `Unauthorised`,
`No data`, `Queued`, `Completed`, `Failed`. SharePoint rejects a value that isn't in the list, and
the flow writes all seven — a missing one fails `Update item` on exactly the path where the log
matters most.

`02_Export_Log.md` is the build reference for this list: seven write points, each with its complete
field list, message expressions and Respond outputs.

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
| `FlowExport_Requests` | Global Order List | `ID`, `RequestType`, `CountryName`, `GDID`, `Requestedfor`, `Provider`, `Ticket_ID`, `PhoneNr`, `ICCID`, `SIMType`, `newSimType`, `PlanName`, `NewPlan`, `VRCompatible`, `DeliveryAddress`, `Location`, `simInventoryID`, `TransferdTo`, `StartDate` |

**`ID` in every one of them.** It is not returned automatically when column limiting is on.
Without it `item()?['ID']` is null, which means a blank `RequestID` column in the export and a
correct-looking file that's missing its one linking column.

Note `FlowExport_Requests` deliberately excludes `WorkHistory`, `ApprovalPlanJson`,
`Justification` and `LineManager`. The Select map is the primary allow-list; the view is the second
one, and the reason both exist is in `09` §1.

### 1.6 The output library

Create `/SIM Exports/Files` as a document library. Apply the retention policy from `09` §2 at the
same time, not later — retrofitting retention across a library of several thousand files is a
different job.

### 1.7 Templates

In `/Shared Documents/SIMRI Templates/`. Full metadata, identifiers and drive IDs in
`12_Template_Files.md`.

| File | State | Action |
|---|---|---|
| `Update_Inventory_tetemplate.xlsx` | exists · 33.8 KB | Nothing to create. |
| `Requests_Export_Template.xlsx` | **needs building** | New file. One plain Excel Table (`Table_Requests`), headers matching `04_Order_List_Schema.md`'s nineteen-column map exactly, `ICCID` column formatted as Text (`@`) — same reason as the inventory template's `ICC_ID` column. No protection, no formula/check columns, no per-type sheets: this replaces the old five-sheet provider handover workbook entirely. Point `simri_HandoverTemplate` at it once built. |

Three things to know before you touch either:

- **The library is *Documents* in the UI and *Shared Documents* in the URL.** Every path-based
  action needs the URL form.
- **The inventory filename has a typo** — `tetemplate`. Leave it or fix it deliberately; it serves
  the import flow as well, so a rename can break an admin's bookmarked upload template.
- **The inventory template carries the sensitivity label "For internal use only"**, and copies
  inherit it. See §3 and §6 test 0 — this is the one prerequisite that can invalidate the design.
  Confirm what label the new Requests template needs before building it — `09` §3a.

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
| `simri_InventoryTemplate` | Text | `/Shared Documents/SIMRI Templates/Update_Inventory_tetemplate.xlsx` |
| `simri_HandoverTemplate` | Text | `/Shared Documents/SIMRI Templates/Requests_Export_Template.xlsx` |
| `simri_FlowEnvironmentId` | Text | the Power Platform environment GUID from the maker portal URL |
| `simri_SupportEmail` | Text | wherever the failure digest should land |

**Why this is not optional at a bank.** A flow with a site URL typed into three expressions and a
list GUID typed into a composed body cannot be exported to UAT — someone edits it by hand, misses
one, and a test run writes to production data.

If environment variables are not available to you, the minimum fallback is **one root-level Compose
per value**, referenced everywhere, so there is exactly one place to change.

---

## 3. Connections, identity and DLP

| Check | Why |
|---|---|
| The flow's SharePoint connection runs as a **service account**, not a named person | when that person leaves, every export stops, and the log's audit trail suddenly attributes writes to a disabled account |
| That account has **write** on `/SIM Exports/Files`, **read** on both templates | least privilege; it does not need write on the Order List or site collection admin — neither export path writes back |
| The Outlook connection's mailbox is documented | the async email's From address is the first thing an admin asks about |
| SharePoint + Excel Online + Outlook are in the same DLP data group | a policy that separates them blocks the flow from saving at all, with an error that does not say so clearly |
| Organisation-scoped sharing links are permitted | `03` §11.8. If not, the flow still works — it falls back to the download URL — but confirm before go-live rather than discovering it in the first failure |
| **The "For internal use only" sensitivity label does not apply encryption** | the inventory template carries it and its output inherits it. An encrypting label stops `Get file content`, `Create file` and above all **Excel Run script** from working at all. §6 test 0, and `12_Template_Files.md` for what each outcome means |
| The Requests template's sensitivity label is settled | it may need a different label if the file leaves the bank — a policy question with a lead time, not a build setting. `09` §3a |

---

## 4. Office Scripts

Both scripts must be saved in a location the flow's connection can reach — the connection owner's
OneDrive, or a SharePoint library shared with them. A script saved in a developer's personal
OneDrive is a production dependency on that developer's account.

| Script | Status |
|---|---|
| `CopyRowsIntoTable` | existing, production, unchanged — now shared by **both** export paths (`03` §11.5) |
| `ReadUploadGate` | new — **`ReadUploadGate.ts` in this folder**. `03` §13, Inventory only. Never throws: on any problem it returns `available:false` with a reason rather than a zero it did not measure |

---

## 5. Build order

The spec is written in build order and every action is defined before it is referenced, so working
top to bottom works. Requests is now structurally a near-copy of Inventory — same script, same
chunking, same finalize shape — so build and test the Inventory path end to end first: it exercises
everything shared (trigger, variables, logging, the sync/async split, the catch scope, the response
contract), and the Requests branch is then mostly "point the same actions at the Order List and the
new template."

---

## 6. Test plan

In order. Each test is written so a failure tells you which assumption was wrong.

### Test 0 — the sensitivity label. Do this before anything else.

Five minutes, and it decides whether the rest of the design is buildable.

1. A throwaway flow: `Get file content using path` on
   `/Shared Documents/SIMRI Templates/Update_Inventory_tetemplate.xlsx`
2. → `Create file` into `/SIM Exports/Files`
3. → Excel Online **Run script** against the copy, running anything trivial

**If the script runs**, the label is metadata-only and everything in `03` works. Note that the
output file inherits the label, which is fine and probably desirable. Repeat against the new
Requests template once it exists.

**If the script fails** with a permissions or format error, the label applies encryption. Stop.
The chunked-write design cannot work as specified, and the fix is an Information Security
conversation about an exemption for the flow's service account. `12_Template_Files.md` has the
detail. Discovering this after building the flow is the avoidable version of a bad week.

### Wiring

**1. Parameter order.** Run once from PowerApps with three distinguishable values. In the run
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

**9. All five request types present in one export.** Confirm every row lands in the same flat
table, columns that don't apply to a given row's `RequestType` are simply blank (e.g. `newSimType`
empty on a New SIM row), and `Delegate` rows are absent entirely — not present-and-blank, genuinely
not in the file, because the filter excludes them before the query ever runs.

**10. An ICCID with 20 digits.** Type one into the template by hand before shipping it, and check
one in a generated file. If it displays as `8.94001E+18` or ends in zeros, the column is not
Text-formatted. There is no runtime guard against this any more — confirm it by hand, and treat
this test as a standing regression check, not a one-time build step.

**11. A country with no approved, non-Delegate requests.** Expect **no file**, `status = No data`,
"No approved requests found for `<country>`.", a log item at `No data`, run history `Succeeded`.
Confirm the same result whether there are zero approved requests or the only approved ones are all
`Delegate` — both read the same way now.

**12. Chunking.** More than `varChunkSize` requests, so at least three chunks run. Confirm no
request appears twice and the final row count matches `varShaped`'s length exactly.

**13. Re-run the same export.** Must produce the same file, with the same rows, every time — this
is expected and correct. If anything about the flow assumes a re-run should differ from the first
run, that assumption is wrong; there is no dedup on this path by design.

### Failure

**14. Async failure.** Force a failure after `Respond queued`. Expect: no second Respond attempt,
a failure **email** to the actioning admin, a log item at `Failed` with a readable `ErrorMessage`,
and no partial file left behind. A second Respond would take the catch scope down with it and the
user would get silence.

**15. Sharing link blocked.** Temporarily deny organisation-scoped links, or point the action at a
bad identifier. The export must still complete, with `shareUrl` empty and `fileUrl` working.

**16. A file left locked after a forced failure.** Force `Create sharing link` to fail hard (not
just the tolerated "continue on failure" path) right after a chunked write, so the catch's
`Delete partial file` fires while the file may still carry a brief SharePoint co-authoring lock from
the preceding `Run CopyRowsIntoTable` calls. Confirm the delete either succeeds (possibly after
retry) or, if it doesn't, that the run still completes and the orphaned file is visible via `08` §7's
runbook rather than silently lost.

### Delivery and downstream

**17. Async threshold.** An export just over `varThreshold`. Expect a response in about four
seconds, `status = Queued`, a log item at `Queued`, then an email with a **link** — never an
attachment. Confirm `Delivery = Emailed` on the final log row.

**18. Popup blocked.** Block popups in the browser and click Export. The user must still be able to
get the file from the selectable `shareUrl` label.

**19. Two admins export the same country at once, both types.** Expect two independent successful
runs, two files, two log rows. Neither should reject, block, or interfere with the other — confirm
this is actually true rather than assuming it, since it's a behaviour change from the earlier
stamped design.

---

## 7. Runbook — what to do when something goes wrong

| Symptom | First thing to check | Recovery |
|---|---|---|
| Log item stuck at `Running` or `Queued` for over a day | run history for that RunId — a cancelled run or a platform timeout reaches neither terminal action | nothing to clean up on the Order List — just re-export. `02`'s "Stuck runs" view finds these |
| A file is left in `/SIM Exports/Files` after a failed or undelivered export | the log row's `Notes` and `Status` for that RunId — `03` §16.5's delete is best-effort and can fail if the file is still momentarily locked from a preceding write | manually delete once any lock clears (usually within a couple of minutes), or leave it — the 90-day retention policy (`09` §2) will purge it eventually |
| Provider's workbook has no formulas where expected | check columns hold values instead of formulas | check `repairFormulas` on the relevant `Run CopyRowsIntoTable` call — Inventory's should be `true`; the Requests template has no formula columns to repair, so this only applies to the Inventory path |
| ICCIDs end in zeros | the column lost its `@` format | check the template directly — there is no automatic guard on either path; `08` §6 test 10 is the standing check |
| Export works but nothing is logged | `varLogItemId` is 0 — `Create log item` failed, or `?['ID']` casing is wrong | test 2 |

---

## 8. Before go-live

- [ ] All 19 tests pass, including 8, 13 and 19
- [ ] The scheduled failure-digest flow exists and has sent one "nothing to report" email
- [ ] Retention is applied to `/SIM Exports/Files` and confirmed in the compliance record (`09`)
- [ ] `00` open items O1 and O2 are closed and the filter's literal values match the real choices
- [ ] O4 — external transfer of employee data — has an answer from Data Protection, in writing
- [ ] `varThreshold` has been set from measured timings, not from 2000 being a round number
- [ ] Test 0 passed for **both** templates — the sensitivity label does not block the Run script
      action
- [ ] The sensitivity label question in `09` §3a has an answer for the Requests template: either
      it's relabelled for controlled external sharing, or the deviation is accepted in writing
- [ ] The Requests template exists, matches `04_Order_List_Schema.md`'s column map exactly, and its
      `ICCID` column is Text-formatted
- [ ] The connection identity is a service account and is documented
- [ ] One local admin who was not involved in building this has run an export start to finish
      without being told how
