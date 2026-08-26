# Export flow — scenarios and how each is handled

Every case below is **decided and specified**. The "Handling" column is not a suggestion; it says
where in `03_Export_Flow_Spec.md` the behaviour is built. If you are looking for the reasoning
behind a decision it is in `00_Design_Decisions.md`; if you are looking for what to build, follow
the section reference.

Ordered by cost if missed.

---

## 1. Empty results

| Case | Handling |
|---|---|
| No approved, non-Delegate requests for that country | **No file.** Respond "No approved requests found for Romania." Creating an empty workbook trains people to send empty files onward. Still logged, as `No data`. `03` §10.6 |
| Approved requests exist, but all are `Delegate` | Excluded by the filter itself (`RequestType ne 'Delegate'`, `03` §10.3) — a `Delegate`-only country produces the same "no approved requests" outcome as a country with none at all. There is no separate message for this case any more; both read as "nothing to export" |
| Country has zero SIMs (inventory export) | No file, clear message. `03` §10.6 |

---

## 2. Delivery

| Case | Handling |
|---|---|
| **Large export by email** | A 60,000-row inventory workbook is ~28 MB. Outlook caps attachments around 25 MB, so the async path emails a **link**, never an attachment. `03` §14 |
| Browser blocks the popup from `Launch()` | PowerApps shows `gblExport.shareUrl` in a selectable label as well. A blocked popup is silent — the user just sees nothing happen. `03` §15 |
| The sharing-link action is blocked by tenant policy | `Create sharing link` is configured to continue on failure and the flow falls back to the `download.aspx` URL. A tenant sharing policy must never fail an export that already built its file. `03` §11.8 |
| User has no mailbox / is external | The sync path doesn't care. On the async path the failure email also fails, so the log is the fallback — the run's `ExportFile` URL is written to the log item, and `02`'s "My exports" view is what the admin checks. `02` §Views |
| Filename collision | RunId in the filename makes it impossible. Same pattern as the import. `03` §6 |
| Country name with a space or apostrophe | `United Arab Emirates`, `Côte d'Ivoire`. Apostrophes are doubled for OData (`03` §10.3); spaces become hyphens in the filename; the URL is built from `Create file`'s `Path` output, correctly encoded, and is never string-built from a guessed shape. `03` §11.3, §11.8 |

---

## 3. Concurrency and repeats

| Case | Handling |
|---|---|
| User double-clicks Export | The Export button's `DisplayMode` is bound to `locBusy` in PowerApps. `03` §15 |
| Two admins export the same country at once | **Harmless, for both export types.** Both are read-only, so two simultaneous exports just produce two identical files — there is nothing left to protect against a second run reading rows a first run already claimed |
| Trigger concurrency | **Leave it OFF.** Turning it on is irreversible in Power Automate, and there's no benefit to it now — no queueing is needed when concurrent runs don't conflict. `03` §0 |
| Same country exported repeatedly | Fine, and visible in the log. `02`'s "By country, last 30 days" view shows it — a country exporting daily usually means the process isn't working, not that the flow is broken |

---

## 4. Template and state

| Case | Handling |
|---|---|
| Template missing or renamed | `Get file content using path` fails naming the path. The catch scope logs it and responds with a readable message. `03` §11.3, §16 |
| Template open by someone in Excel | Reading still works; SharePoint only locks writes. No action needed, but worth knowing before someone reports it as a bug. |
| An ICCID column loses its Text (`@`) format | Neither export path has a runtime guard against this any more — `assertTemplate()` was `BuildRequestSheets`-specific and left with it. A 20-digit ICCID silently truncates to 15 significant digits or renders in scientific notation if the column isn't Text-formatted. This is now a build-time check, not a runtime one: verify both templates' ICCID columns by hand before shipping, and `08` §6 test 10 types a 20-digit ICCID in by hand as the standing regression check. |
| Flow times out mid-write | A partial file exists in the library. It is never delivered — the URL is only returned after the file is complete, and the catch scope deletes it. `03` §16.5 |
| The write loop exits early | `03` §11.6 asserts `varChunkOffset >= length(varShaped))` after the loop and fails deliberately if not. Without it a `Do until` that hits its iteration cap **exits normally**, and the flow would report success on a workbook missing half its rows. |

---

## 5. Authorisation

The PowerApps picker limits an admin to their own countries, but the flow does not trust it — a
flow callable from the app is callable with any parameters by anyone who can call the app.

**Handled — `03` §10.2.** `ActionedBy` is validated against the requested country's Local Admin
fields on the **SIMRI Country Matrix** — the list the app already maintains, so who administers a
country has one home rather than two. A mismatch is rejected with a clear message, logged with
status `Unauthorised` so it is filterable separately from a user who forgot to pick a country, and
terminated.

One detail that decides whether this works at all: the three admin clauses must be **parenthesised**
(`11` §Authorisation). Without the brackets, OData precedence lets anyone listed as Local Admin 2
for any country export every country.

**Be honest about what this is.** There is no trustworthy caller identity on a PowerApps V2
trigger. This stops casual misuse and gives you an audit trail. It is not an access control.
Recorded as a residual risk in `09` §5 rather than implied to be closed.

Related and easy to miss: every caller-supplied value that reaches an OData filter is escaped
before use (`03` §10.3). `Country` was escaped in v2 for the `Côte d'Ivoire` case;
`ActionedBy` was not, which made the authorisation filter itself injectable. Both are escaped now.

---

## Priority, if you are building this in order

1. **§4's write-loop assertion** — the one silent failure that produces a result looking perfectly
   normal. Build and test this before anything else.
2. **§1 and §2's messaging** — the most frequent scenarios, and cheap to get right.
3. **§3's "two admins at once" case** — worth a quick sanity check even though it needs no special
   handling; confirming it really is harmless is cheaper than assuming so.
