# Export flow — scenarios to cover

Grouped by how much damage they do if missed. Each has a recommended handling; the ones marked
**DECIDE** need your call before I build.

---

## 1. The expensive one: the same request handed over twice

An approved request is exported on Monday. The provider fills it in and returns it. On Wednesday
someone exports again — the request is still `Approved`, so it goes out a second time. The
provider provisions a second SIM, returns a second file, and you end up with a duplicate SIM in
the inventory and a bill for a line nobody asked for.

Nothing in the current design prevents this. It is the only failure here that costs real money.

**Recommended handling** — a state transition, not just a filter:

- Add `ExportedOn` (DateTime) and `ExportRunId` (Text) to the Order List
- The export takes requests where `Status = Approved` **and** `ExportedOn` is empty
- After a successful write, stamp both fields on every exported request
- A "Re-export" toggle on the PowerApps button overrides the filter, for the genuine case where a
  provider lost the file — and the log records that it was a re-export

**DECIDE:** stamping requests means the export *writes* to the Order List, which turns a
read-only operation into a read-write one. The alternative is a `Status` transition
`Approved → Sent to provider`, which is more visible in the list UI but needs the choice column
extended and any views or flows filtering on `Approved` updated.

---

## 2. Empty results

| Case | Handling |
|---|---|
| No approved requests for that country | **No file.** Return a message to PowerApps: "No approved requests for Romania." Creating an empty workbook trains people to send empty files to providers. Still logged. |
| Approved requests exist, but all are `Delegate` (never goes to a provider) | Distinct message: "3 approved requests, none require provider action." Different from nothing being there, and the difference matters to the admin. |
| Some types have rows, others don't | Only create tabs for types actually present. A provider opening five tabs where two have data will assume the empty ones are a mistake. |
| Country has zero SIMs (inventory export) | Same as above — no file, clear message. |
| All approved requests already exported | "All 12 approved requests were already sent to the provider on 05-08-2026." Names the date, so the admin knows where to look rather than assuming a bug. |

---

## 3. Request types the flow doesn't know about

Someone adds a new choice value to the Order List — say `Upgrade device` — six months from now.
The script has no tab mapping for it.

**Never drop it silently.** Route unmapped types to an `Unmapped` tab and count them in the
report, so the admin sees "4 requests of type 'Upgrade device' were exported to the Unmapped tab
— they have no provider columns defined." The alternative is a request that quietly never
reaches the provider and surfaces weeks later as a complaint.

---

## 4. Data quality before handover

A request missing its employee name or cost centre is one the provider will bounce back, after a
week.

**Validate before writing.** Rows failing a mandatory-field check go to a `Needs attention` tab
rather than the provider tabs, and the report lists them. The admin fixes them and re-exports;
the provider never sees a half-formed request.

Worth checking per type: employee identifier, cost centre, legal entity, and — for Swap and
Change plan — the existing ICC_ID or phone number the request refers to.

---

## 5. Delivery

| Case | Handling |
|---|---|
| **Large export by email** | A 60,000-row inventory workbook is ~28 MB. Outlook caps attachments around 25 MB, so the async path must email a **link**, never an attachment. |
| Browser blocks the popup from `Launch()` | Show the URL in the app as selectable text too, so there's always a fallback. A blocked popup is silent — the user just sees nothing happen. |
| User has no mailbox / is external | The sync path doesn't care. The async path needs a fallback: write the link to the log list and have the app poll for it. |
| Filename collision | RunId in the filename makes this impossible. Same pattern as the import. |
| Country name with a space or apostrophe | `United Arab Emirates`, `Côte d'Ivoire`. URL-encode for the download link, and strip or replace for the filename. |

---

## 6. Concurrency and repeats

| Case | Handling |
|---|---|
| User double-clicks Export | Disable the button in PowerApps while the flow runs. Harmless if it slips through — two identical files — but it doubles the run count and confuses the log. |
| Two admins export the same country at once | Each gets their own file. Fine for inventory. **Not fine for requests** if stamping is on: both would export the same rows before either stamps them. Trigger concurrency `1` fixes it, at the cost of queuing. |
| Same country exported repeatedly | Fine, and visible in the log. Worth a view showing exports per country per week — a country exporting daily usually means the process isn't working. |

---

## 7. Template and state

| Case | Handling |
|---|---|
| Inventory template missing or renamed | Fail fast with a message naming the file, not a generic connector error. |
| Template open by someone in Excel | Reading it still works; SharePoint only locks writes. No action needed, but worth knowing before someone reports it as a bug. |
| Template gains a column, script's `DATA_FIELDS` doesn't | Silent mismatch — the column exports empty. The script should compare the table's headers to what it expects and warn. |
| Flow times out mid-write | A partial file exists in the library. It should not be delivered. Only return the URL after the file is complete, and let the catch scope delete partial files. |

---

## 8. Authorisation

The PowerApps picker presumably limits an admin to their own countries, but the flow should not
trust that — a flow callable from the app is callable with any parameters by anyone who can call
the app.

**Recommended:** validate that `ActionedBy` is permitted to export the requested country, from a
`Country Admins` list. Reject with a clear message and log the attempt. Cheap to build, and it
means the export can never become a data-exfiltration route for the whole estate.

---

## 9. The return leg (not this flow, but decide the shape now)

| Case | Why it matters now |
|---|---|
| Provider returns a partially filled file | The import must handle "3 of 10 rows completed" — update those, leave the rest pending. |
| Provider edits a request column despite protection | Match on RequestID and reject rows whose protected values don't match the export. Requires the export to record what it sent. |
| Provider returns an old file after a re-export | The hidden RunId identifies which export it came from. Without it, stale data overwrites fresh data silently. |
| Two providers return files for the same request | Same defence — RunId plus the `ExportedOn` stamp. |

Every one of these is solved by the same thing: **a hidden metadata sheet carrying RunId,
country, export timestamp and a row count**, written at export time. It costs nothing now and is
awkward to add later once providers are used to a format.

---

## Priority

1. **Double-handover prevention** (§1) — the only one with a financial cost
2. **Empty and already-exported messaging** (§2) — the most frequent, and cheap
3. **Hidden metadata sheet** (§9) — trivial now, expensive to retrofit
4. **Unmapped request types** (§3) — silent data loss otherwise
5. Everything else is polish, though §5's 25 MB attachment limit will bite the first time someone exports a large country.
