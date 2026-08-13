# SIM Export Log — list schema and logging points

List: **SIM Export Log**. One item per export run. Same shape as the import log in
`../SIM Inventory/Logging_System.md`, so both read the same way — but this is a **new flow built
from scratch**; nothing is inherited from the import flow.

**Actions this document references, all defined in `03_Export_Flow_Spec.md`:**

| Reference | Defined in | What it is |
|---|---|---|
| `outputs('Compose_Flow_Identity')` | §2a | Compose holding the run's URL |
| `outputs('Compose_threshold')` | §2c | the sync/async row threshold |
| `body('Create_log_item')` | §3 | this list's Create item, for the returned `ID` |
| `result('Scope_-_Main')` | §8 | the main Scope, for the catch path |
| every `variables('var…')` | §2 | the variable table |

If you rename any of those actions, the expressions here break — Power Automate resolves them by
name.

---

## Columns

| Column | Type | Notes |
|---|---|---|
| **Title** | Single line of text | Required by default. `2026-08-13 14:22 · Romania · Requests` |
| **RunId** | Single line of text | **Index this.** Also written into the workbook's hidden metadata sheet, so a file in someone's inbox can be traced to the run that produced it. |
| **ExportType** | Choice: `Inventory`, `Requests` | **Index this.** Room for `Audit` later. |
| **Country** | Single line of text | Index it. |
| **ActionedBy_email** | Single line of text | Text, not Person — survives someone leaving. |
| **Status** | Choice: `Running`, `Completed`, `No data`, `Failed` | **Index this.** `No data` is its own state, not a failure — see below. |
| **Started** | Date and Time | |
| **Finished** | Date and Time | Empty while `Running`. |
| **Rows_Exported** | Number | Total written across all sheets. |
| **Sheet_Breakdown** | Multiple lines, plain text | `New SIM: 12 · Terminate: 3 · Swap: 1`. For Inventory exports, just the row count. |
| **Delivery** | Choice: `Link returned`, `Emailed` | Which branch ran. Tells you whether the sync threshold is set sensibly. |
| **ExportFile** | Hyperlink | The generated workbook. |
| **FlowRun** | Hyperlink | Run history, while it exists. |
| **Notes** | Multiple lines, plain text | Human-readable summary, and the reason when `Status = No data`. |
| **ErrorMessage** | Multiple lines, plain text | Catch path only. Separate so you can filter "is not empty". |

**`No data` is a status, not an error.** "No approved requests for Romania" is a perfectly
successful run that produced no file. Filing it as `Failed` means your failure view fills with
non-problems and people stop reading it.

**Plain text, not enhanced rich text** on both multi-line columns. **Versioning off** — each item
is written twice by design.

---

## Logging points

Same three-point pattern as the import, and for the same reason: a run that times out or is
cancelled reaches neither terminal action, and those are the runs worth investigating.

```
Trigger (PowerApps V2)
Initialize variables
  ┌──────────────────────────────────────────────┐
  │ LOG 1 — Create item · Status: Running        │   ← before Scope - Main
  │ Set varLogItemId                             │
  └──────────────────────────────────────────────┘
Scope - Main
    Validate inputs · resolve country
    Get items (Inventory or Order List, by ExportType)
    Shape · build workbook · save to /SIM Exports/Files
  ┌──────────────────────────────────────────────┐
  │ LOG 2 — Update item · Completed / No data    │   ← last action INSIDE Scope - Main
  └──────────────────────────────────────────────┘
    Respond to PowerApps  OR  send email
Scope - Catch
  ┌──────────────────────────────────────────────┐
  │ LOG 3 — Update item · Failed                 │
  └──────────────────────────────────────────────┘
    Respond with the error · Terminate
```

**Log 2 goes inside the Scope**, before the response. Outside it, a failure responding to
PowerApps would leave the log claiming `Running` on a run that actually produced a file.

**`Respond to a PowerApp` must be reachable on both paths.** If the catch scope terminates
without responding, PowerApps sits waiting until it times out and the user sees nothing. The
catch must respond with a message the app can display before terminating.

---

## Inputs

### Log 1 — Create item

| Field | Value |
|---|---|
| Title | `RUNNING · @{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} · @{triggerBody()?['text']} · @{triggerBody()?['text_1']}` |
| RunId | `@{variables('varRunId')}` |
| ExportType | `@{triggerBody()?['text_1']}` |
| Country | `@{triggerBody()?['text']}` |
| ActionedBy_email | `@{triggerBody()?['text_2']}` |
| Status | `Running` |
| Started | `@{variables('varStartedUtc')}` |
| Rows_Exported | `0` |
| FlowRun Url | `@{outputs('Compose_Flow_Identity')}` |
| FlowRun Description | `Flow run` |

Then `Set varLogItemId` = `body('Create_log_item')?['ID']`.

### Log 2 — Update item

Repopulate **every** field — SharePoint's `Update item` writes the whole item, so anything left
blank is written as blank.

| Field | Value |
|---|---|
| Title | `@{formatDateTime(variables('varStartedUtc'),'yyyy-MM-dd HH:mm')} · @{triggerBody()?['text']} · @{triggerBody()?['text_1']} · @{variables('varRowsExported')} rows` |
| Status | `@{if(equals(variables('varRowsExported'),0),'No data','Completed')}` |
| Finished | `@{utcNow()}` |
| Rows_Exported | `@{variables('varRowsExported')}` |
| Sheet_Breakdown | `@{variables('varSheetBreakdown')}` |
| Delivery | `@{if(greater(variables('varRowsExported'),outputs('Compose_threshold')),'Emailed','Link returned')}` |
| ExportFile Url | `@{variables('varFileUrl')}` — empty when `No data` |
| ExportFile Description | `@{variables('varFileName')}` |
| Notes | summary, or the reason for `No data` |
| plus RunId, ExportType, Country, ActionedBy_email, Started, FlowRun | repeated from Log 1 |

### Log 3 — Catch

Same fields, with `Status = Failed`, `ExportFile` empty, and
`ErrorMessage = @{string(result('Scope_-_Main'))}`.

---

## Views

| View | Filter | Use |
|---|---|---|
| **Failures** | `Status = Failed` | Daily check. |
| **Stuck runs** | `Status = Running` AND `Started < [Today]-1` | Runs that reached neither terminal action. |
| **No data** | `Status = No data` | A country repeatedly exporting nothing usually means requests aren't being approved, not that the export is broken. |
| **By country, last 30 days** | grouped on Country | The double-handover detector: the same country exporting Requests twice in a week, with similar row counts, is worth a look. |

That last view is what makes the read-only decision safe. It doesn't prevent a duplicate
handover, but it makes one visible to anyone who looks.
