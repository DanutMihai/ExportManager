# Export flow — scenarios and how each is handled

Every case below is **decided and specified**. The "Handling" column is not a suggestion; it says
where in `03_Export_Flow_Spec.md` the behaviour is built. If you are looking for the reasoning
behind a decision it is in `00_Design_Decisions.md`; if you are looking for what to build, follow
the section reference.

Ordered by cost if missed.

---

## 1. The expensive one: the same request handed over twice

An approved request is exported on Monday. The provider fills it in and returns it. On Wednesday
someone exports again — the request is still `Approved`, so it goes out a second time. The
provider provisions a second SIM, returns a second file, and you end up with a duplicate SIM in
the inventory and a bill for a line nobody asked for.

It is the only failure here that costs real money.

**Handled — `03` §12.** A state stamp, not just a filter:

- `ExportedOn` (DateTime) and `ExportRunId` (Text) on the Order List
- The export takes `OrderStatus eq 'Approved'` **and** `ExportedOn eq null`
- After the file is confirmed written, both fields are stamped on every request that actually
  reached a provider sheet, in one `utcNow()` per run, via OData `$batch` at 100 rows per call
- Requests the script routed to `skipped` are **not** stamped — they were never sent, so the next
  export picks them up (`03` §12.3)
- A `ReExport` toggle overrides the `ExportedOn` filter for the genuine case where a provider lost
  the file, and the log records that the run was a re-export (`02`, `ReExport` column)

**Not a `Status` transition**, and the reason is worth keeping: extending the `OrderStatus` choice
column means hunting down every view, filter and flow that keys on `Approved`, including ones you
do not own. Two additive columns break nothing, and `ExportRunId` doubles as the key the
return-leg import needs.

**The stamping failure is compensated, not left half-done.** If a `$batch` call reports a failed
operation part-way through, some rows are stamped and the file is about to be deleted — which
would leave requests marked as sent that never were, the exact failure stamping exists to prevent.
`03` §16.6 clears `ExportedOn` and `ExportRunId` for every row carrying this run's `ExportRunId`
before the run terminates. That is what makes the whole export safely re-runnable.

---

## 2. Empty results

| Case | Handling |
|---|---|
| No approved requests for that country | **No file.** Respond "No approved requests for Romania." Creating an empty workbook trains people to send empty files to providers. Still logged, as `No data`. `03` §10.6 |
| Approved requests exist, but all are `Delegate` | Distinct message: "3 approved requests, none require provider action." Different from nothing being there, and the difference matters to the admin. `03` §10.6 |
| All approved requests already exported | "All 12 approved requests for Romania were already sent to the provider. Use Re-export if the provider needs the file again." `03` §10.6 |
| A mix — some already sent, some Delegate | "Nothing new to send for Romania — 8 already sent, 4 are Delegate." `03` §10.6 |
| Some types have rows, others don't | Only tabs for types actually present. Empty sheets are deleted on the finalize chunk, so a provider never opens five tabs where two have data and assumes the empty ones are a mistake. `BuildRequestSheets.ts`, finalize block |
| Country has zero SIMs (inventory export) | No file, clear message. `03` §10.6 |
| Every request was skipped as unmapped or incomplete | **No file, and the partial file is deleted.** The workbook would otherwise contain nothing but the Instructions sheet. The skipped list goes to the response, the email and the log. `03` §11.7a — this case did not exist in v2 and would have delivered an empty workbook with a "0 rows" success message |

---

## 3. Request types the flow doesn't know about

Someone adds a new choice value to the Order List — say `Upgrade device` — six months from now.
The script has no `typeMap` entry for it.

**Handled — never dropped, never shipped.** The request comes back in the script's `skipped`
array with reason `unmapped:Upgrade device`, is reported in the response, the email and the log's
`Notes`, and is **left unstamped** so the next export picks it up once the type is mapped.

The v1 design routed these to an `Unmapped` tab inside the workbook the provider receives. That
is reversed: an admin concern does not belong in an external party's file. See §4.

---

## 4. Data quality before handover

A request missing its employee identifier or delivery address is one the provider will bounce
back, after a week.

**Handled — validated before writing, reported to the admin, not shipped.** `BuildRequestSheets`
checks the per-type `required` list from `typeMap` (`03` §17). Rows failing it come back in
`skipped` with reason `missing:<fields>` and are excluded from the workbook and from stamping.
The admin fixes them and re-exports.

Required per type, as specified in `03` §17's `typeMap`:

| Type | Required before handover |
|---|---|
| New SIM | `gdid`, `requestedFor`, `provider`, `deliveryAddress` |
| Terminate | `gdid`, `requestedFor`, `provider`, `phoneNr` |
| Swap | `gdid`, `requestedFor`, `provider`, `iccid`, `newSimType` |
| Transfer | `gdid`, `requestedFor`, `provider`, `phoneNr`, `transferdTo` |
| Change plan | `gdid`, `requestedFor`, `provider`, `phoneNr`, `newPlan` |

**No `Needs attention` tab, no `Unmapped` tab.** `01`'s own goal — the provider never sees a
half-formed request — is met by keeping them out of the file and putting them in the admin's
response message, the async email and the log's `Notes`. Silent data loss is still prevented; the
provider simply isn't the one told about it.

---

## 5. Delivery

| Case | Handling |
|---|---|
| **Large export by email** | A 60,000-row inventory workbook is ~28 MB. Outlook caps attachments around 25 MB, so the async path emails a **link**, never an attachment. `03` §14 |
| Browser blocks the popup from `Launch()` | PowerApps shows `gblExport.shareUrl` in a selectable label as well. A blocked popup is silent — the user just sees nothing happen. `03` §15 |
| The sharing-link action is blocked by tenant policy | `Create sharing link` is configured to continue on failure and the flow falls back to the `download.aspx` URL. A tenant sharing policy must never fail an export that already built its file. `03` §11.8 |
| User has no mailbox / is external | The sync path doesn't care. On the async path the failure email also fails, so the log is the fallback — the run's `ExportFile` URL is written to the log item, and `02`'s "My exports" view is what the admin checks. `02` §Views |
| Filename collision | RunId in the filename makes it impossible. Same pattern as the import. `03` §6 |
| Country name with a space or apostrophe | `United Arab Emirates`, `Côte d'Ivoire`. Apostrophes are doubled for OData (`03` §10.3); spaces become hyphens in the filename; the URL comes from the connector's `{Link}` / `{Path}`, correctly encoded, and is never string-built. `03` §11.3, §11.8 |

---

## 6. Concurrency and repeats

| Case | Handling |
|---|---|
| User double-clicks Export | The Export button's `DisplayMode` is bound to `locBusy` in PowerApps. `03` §15 |
| Two admins export the same country at once | **This is the one that matters, because both would read the same unstamped rows and both hand them over.** Handled by a soft claim against the log list (`03` §10.2b): a Requests export rejects if an *older* `Running` Requests export exists for the same country in the last 30 minutes. Older, not any — the flow's own log item is already `Running` by the time it checks, so "any" would make every export reject itself, and a simultaneous pair would reject each other. |
| Trigger concurrency | **Leave it OFF.** Turning it on is irreversible in Power Automate, and it would queue inventory exports behind requests exports for no benefit. The soft claim is reversible and visible in the list. `03` §0 |
| Same country exported repeatedly | Fine, and visible in the log. `02`'s "By country, last 30 days" view shows it — a country exporting daily usually means the process isn't working. |

---

## 7. Template and state

| Case | Handling |
|---|---|
| Template missing or renamed | `Get file content using path` fails naming the path. The catch scope logs it and responds with a readable message. `03` §11.3, §16 |
| Template open by someone in Excel | Reading still works; SharePoint only locks writes. No action needed, but worth knowing before someone reports it as a bug. |
| Template gains a column the payload has no key for | Not a failure. Header-to-key matching (`03` §17) leaves it blank and reports it in `unfilledHeaders`, which lands in the log's `Notes`. Compare that list against the expected fill-in columns on the first run — anything unexpected in it is drift. |
| Template ships with rows in it | `assertTemplate()` refuses to run and names the table and the row count. Catches "someone saved the template after testing". |
| A text column lost its `@` format | `assertTemplate()` refuses to run and names the sheet and column. This is the guard against a 20-digit ICCID being silently truncated to 15 significant digits. |
| Flow times out mid-write | A partial file exists in the library. It is never delivered — the URL is only returned after the file is complete, and the catch scope deletes it. `03` §16.5 |
| The write loop exits early | `03` §11.6 asserts `varChunkOffset >= length(varShaped)` after the loop and fails deliberately if not. Without it a `Do until` that hits its iteration cap **exits normally**, and the flow would report success on a workbook missing half its rows. |

---

## 8. Authorisation

The PowerApps picker limits an admin to their own countries, but the flow does not trust it — a
flow callable from the app is callable with any parameters by anyone who can call the app.

**Handled — `03` §10.2.** `ActionedBy` is validated against a Country Admins list for the
requested country. A mismatch is rejected with a clear message, logged with status `Unauthorised`
so it is filterable separately from a user who forgot to pick a country, and terminated.

**Be honest about what this is.** There is no trustworthy caller identity on a PowerApps V2
trigger. This stops casual misuse and gives you an audit trail. It is not an access control.
Recorded as a residual risk in `09` §5 rather than implied to be closed.

Related and easy to miss: every caller-supplied value that reaches an OData filter is escaped
before use (`03` §10.3). `Country` was escaped in v2 for the `Côte d'Ivoire` case;
`ActionedBy` was not, which made the authorisation filter itself injectable. Both are escaped now.

---

## 9. The return leg — not this flow, but the shape is fixed now

| Case | Why it is handled at export time |
|---|---|
| Provider returns a partially filled file | The import must handle "3 of 10 rows completed" — update those, leave the rest pending. `_Meta.TotalExpectedRows` tells it what a complete file looks like. |
| Provider edits a protected column despite protection | Match on `RequestID`; reject rows whose protected values don't match what was exported. The `ExportRunId` stamp on the Order List is the record of what was sent. |
| Provider returns an old file after a re-export | `_Meta.RunId` identifies which export it came from. Without it, stale data overwrites fresh data silently. |
| Two files returned for the same request | Same defence — `_Meta.RunId` plus the `ExportedOn` stamp. |
| Provider pasted values, so no validation fired | **The import revalidates everything server-side.** Excel data validation never fires on paste. The `Checks` sheet's `ReturnGate` is a convenience, not a guarantee. |

All of it rests on the same thing: a `veryHidden` `_Meta` sheet carrying RunId, country, who
exported, timestamp, rows written and expected rows, written on the finalize chunk. It costs
nothing now and is awkward to add once providers are used to a format.

---

## Priority, if you are building this in order

1. **§7's write-loop assertion and §1's stamping compensation** — the two silent failures. Both
   produce a result that looks perfectly normal.
2. **§1 stamping** — the only failure with a financial cost.
3. **§2 and §4 messaging** — the most frequent, and cheap.
4. **§9's `_Meta` sheet** — trivial now, expensive to retrofit.
5. **§3 unmapped types** — silent data loss otherwise.
6. **§6's soft claim** — cheap, and the alternative (trigger concurrency) is irreversible.
