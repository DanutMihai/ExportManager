# Export flow — review findings (v1)

> ## ⚠️ HISTORICAL — do not build from this document
>
> This is the review of **v1** of the spec, dated 15-08-2026. Everything in it has been applied,
> answered or superseded. It is kept because the *reasoning* is often the clearest record of why a
> design choice is what it is — but the section numbers it cites (`03` §9.x) are v1 numbers and no
> longer exist.
>
> **Build from `03_Export_Flow_Spec.md` v3 and `08_Build_Checklist.md`.**
>
> | Item | Where it landed |
> |---|---|
> | A1–A7, B1–B8, C1–C5 | applied in `03` v2 |
> | D1 stamping | `03` §12, with the compensation in §16.6 added in v3 |
> | D2 `EffectiveDate` + `ProviderNotes` | `04` §3, now closed |
> | D3 sharing link | `03` §11.8 |
> | E1 retention | `09` §2 |
> | E3 `DurationSeconds`, E9 success message | `02` columns, `03` §11.8 |
> | E4 failure alerting | `02` §Alerting, `03` §19 |
> | E6 authorisation | `03` §10.2, residual risk in `09` §5 |
> | E10 stale cross-references | fixed in `02` |
> | E11 timezone in the log Title | fixed in `02` |
> | F1, F2, F3 | answered: 10k is a backlog · one provider per country · the admin forwards |
> | F5, F6, F9 | still open — `00` §Open items O1, O2, O3, O5 |
> | F4 external PII transfer | `09`, and `00` open item O4 |
> | F7 multi-country admins | answered: one country per export. `03` §20 records what changes if that flips |
> | F8 real timings | `00` open item O6, measured via `02`'s `DurationSeconds` |
>
> Six defects that survived into v2 and were only caught in the v3 review are listed in
> `10_Review_v3_Findings.md`. Three of them originate in this document's own recommendations —
> notably C4's `where()`, which is not a Power Automate function.

Review of `00`–`04` as of 15-08-2026. Ordered by cost of finding it late.

**Verdict.** The design is sound and unusually well-specified — build-order discipline, the
`?['Value']` handling on Choice columns, apostrophe-doubling in the OData filter, and the
probe-then-decide pattern are all correct and are things most people discover the hard way. What
follows is (A) seven things that will fail at run time, (B) eight data-integrity risks, (C) five
simplifications, (D) answers to the three open DECIDEs, (E) additions worth making, (F) questions.

---

## A. Will fail at run time — fix before building

### A1. `Compose threshold` returns a **string**, not a number

A Compose whose input is typed as `2000` stores `"2000"`. Then:

```
add(outputs('Compose_threshold'),1)                                   → error
lessOrEquals(outputs('Compose_probe_count'), outputs('Compose_threshold'))  → error
greater(variables('varRowsExported'), outputs('Compose_threshold'))   → error
```

`add`, `greater` and `lessOrEquals` throw on a string operand — *"expects its first parameter to
be an integer or a decimal number. The provided value is of type 'String'."*

**Fix.** Replace the Compose with `Initialize varThreshold` (Integer, `2000`) in §2. Same single
point of change, correct type, and it can be referenced from inside Scopes. If you keep the
Compose, wrap it: `int(outputs('Compose_threshold'))` at all three call sites.

### A2. The catch scope cannot respond after `Respond queued` has already run

Async path: `Respond queued` fires (§9.4.1 d), the app unblocks, then `Switch source full` or
`Run BuildRequestSheets` fails. `Scope - Catch` runs `Respond failed` — but a response has
already been sent for this run. The second Respond fails, so **the catch scope itself fails**,
`Update log item failed` may not complete, and the run dies with no log and no notification. The
user, meanwhile, was told "you will receive an email" and never gets one.

**Fix.** Guard 10.2 on `equals(variables('varAsync'), false)`. On the async-failure path send a
**failure email** to `ActionedBy` instead — it is the only channel left open. Better still,
introduce `varResponded` (Boolean, `false`), set it `true` immediately after every Respond, and
gate 10.2 on that; it survives future path changes that `varAsync` would not.

### A3. `Delete partial file` fires when no file exists

The guard is `not(empty(variables('varFileName')))`, but `varFileName` is set at **§6**, long
before `Create export file` at §9.4.2. Any failure between §7 and the file creation — a bad
filter query, a missing template, an auth error — enters the catch with a populated
`varFileName` and no file. `Delete file` returns 404, the catch scope fails.

**Fix.** `Initialize varFileCreated` (Boolean, `false`); set it `true` in the action immediately
after `Create export file`; guard 10.3 on it. Also set 10.3's *Configure run after* to continue
on failure — deleting a stray file is best-effort and must never break the handler.

### A4. `Update log item failed` with `varLogItemId = 0`

If `Create log item` (§7) fails — SharePoint throttling, a choice value that doesn't match, the
list renamed — `varLogItemId` stays `0` and the catch tries `Update item` on ID 0. That fails,
and the catch fails.

**Fix.** Wrap 10.1 in a condition on `greater(variables('varLogItemId'), 0)`. Note that §8
already says *Configure run after* on `Scope - Main` must include **is skipped** so a logging
hiccup doesn't block the export — this is the same hazard on the other end, and it's not
covered yet.

The general rule, which `03` states and then doesn't fully apply: **every reference inside
`Scope - Catch` must be resolvable no matter how early the failure happened.**

### A5. The invalid-input path leaves the log stuck on `Running`

§9.1 runs `Set varMessage` → `Set varStatus` → `Respond invalid` → `Terminate invalid`.
`Terminate` ends the run immediately: §9.5 `Update log item` never executes, and `Scope - Catch`
does **not** run after a Terminate either. The log item created at §7 stays `Status = Running`
forever, and `02`'s "Stuck runs" view fills with input-validation rejections — exactly the
pollution `02` argues against when it insists `No data` is not a failure.

**Fix.** Insert `Update log item invalid` before `Respond invalid`. And consider
`Terminate` with status **`Cancelled`** rather than `Failed` — a user typing nothing into a
picker is not a flow failure, and the run-history failure count is something you will want to
trust.

### A6. `Do until inventory chunks` will silently truncate at 60 iterations

Default `Do until` limits are **Count 60, Timeout PT1H**. Critically, when the count limit is
hit the loop **exits normally — it does not fail**. The flow then reports success, logs
`Rows_Exported` from `length(body('Shape_inventory'))` (the *intended* count, not the written
count), returns a URL, and hands over a workbook that is missing rows nobody will notice.

At 60,000 rows: 1,000/chunk = exactly 60 iterations, on the edge. 500/chunk = 120 iterations,
and half the file is missing.

**Fix.** Two parts, both needed:

1. Raise the loop's Limits to Count `5000`, Timeout `PT2H`.
2. Add an assertion **after** the loop:
   `if(greaterOrEquals(variables('varChunkOffset'), length(body('Shape_inventory'))))` → else
   fail deliberately (a `Terminate` with status `Failed` and a message naming the shortfall).
   A silent short write on a 60,000-row inventory is the worst outcome in this whole design,
   because the file looks perfectly normal.

Log `varChunkOffset` and the expected total into `Notes` so the log can prove completeness.

### A7. `Run BuildRequestSheets` is a single unchunked call — it will time out

`03` §9.4.2 chunks the *inventory* path (`Do until inventory chunks`) but calls
`Run BuildRequestSheets` **once** with the entire `requests` array. `00` puts Requests volume at
up to 10,000 per country.

The Excel Online *Run script* action has a hard **120-second** script timeout and a bounded
request payload. Ten thousand request objects, plus per-sheet writes, plus range locking, plus
sheet protection, plus empty-tab deletion, in one 120-second budget will not finish. And when it
times out you get A7's evil twin — see **B3**.

**Fix.** Give `BuildRequestSheets` the same shape as `CopyRowsIntoTable`: `startRowIndex`,
`totalExpectedRows`, and a `finalize` flag. Chunk the writes; on the final chunk only, do the
protection, empty-tab deletion and `_Meta` write. Then wrap it in the same `Do until` (with A6's
limits and assertion). This is the single largest piece of work the spec is currently missing.

---

## B. Data-integrity risks

### B1. ICCID and PhoneNr will be corrupted by Excel unless the columns are Text

This is the classic one and it is a *silent data-corruption* bug, not an error.

- An ICCID is 19–20 digits. Excel treats it as a number, and numbers carry only 15 significant
  digits — `8940011234567890123` comes back as `8940011234567890000`. The last digits are gone,
  permanently, before the provider even saves the file.
- A 20-digit value in a General column displays as `8.94001E+18`.
- Phone numbers with a leading `+` or a leading `0` lose it.

**Fix.** In the handover template, set `numberFormat = "@"` (Text) on the **fill-in** `PhoneNr`,
`ICCID`/`New ICCID`, `StartDate` and `EffectiveDate` columns, and on the protected `ICCID`/
`PhoneNr` context columns too. Do it in the template, not the script, so it survives even if the
script changes. Verify by typing a 20-digit ICCID into the template by hand before shipping it.

### B2. Data validation does not fire on paste — the return leg must re-validate everything

Excel data validation is only evaluated on **typed** entry. A provider pasting a column of 200
ICCIDs from their own system bypasses every rule in the template. Providers always paste.

This doesn't change the export — the validation is still worth having as UX — but it does change
what you can assume on the return leg. `00` describes the fill-in columns as "validated at
source"; they are *guided* at source. **The return-leg import must revalidate every field
server-side and reject per-row.** Worth writing into `00` now so the import isn't designed on a
false premise.

### B3. Default connector retries will duplicate rows

Every Power Automate connector action defaults to **Exponential, 4 retries**. If
`Run CopyRowsIntoTable` or `Run BuildRequestSheets` times out at 120 seconds *after* having
written some rows, Power Automate retries it — and the script writes them again.

**Fix.** Set retry policy to **None** on both Run script actions, and make the scripts idempotent
anyway (clear the target range from `startRowIndex` before writing). Keep Exponential/4 on the
SharePoint read and log actions, where retrying is safe and useful. §7 already specifies
Exponential 4 on `Create log item`, which is correct — the point is that it must not be the
default everywhere.

### B4. `Delegate` is never filtered out, so three counters disagree

`01` §2 wants a distinct message when all approved requests are `Delegate`. But the §9.2 filter
is `CountryName eq '…' and OrderStatus eq 'Approved'` — Delegate rows are fetched and counted.
Consequence: `Compose probe count` says 3, `Has data` is true, the flow builds a file, the script
writes 0 provider rows, and `Update log item` computes
`if(equals(varRowsExported,0),'No data','Completed')` → **`No data` on a run that created a file
and returned a URL.** The admin gets a link to an empty workbook.

**Fix.** Add `and RequestType ne 'Delegate'` to the OData filter, and handle the "approved
requests exist but none are provider-facing" case from the probe count *before* building. Cleaner
than fixing it downstream, and it keeps the probe count honest — which everything else depends on.

### B5. The log's `Delivery` field is derived from the wrong value

`02`: `Delivery = if(greater(varRowsExported, threshold),'Emailed','Link returned')`. But the
async decision was made on the **probe count**, not on rows written. Probe 2,100 (async) minus
Delegate and Needs-attention rows → 1,950 written → the log records "Link returned" for a run
that emailed. Since `02`'s stated purpose for this field is *"tells you whether the sync
threshold is set sensibly"*, a field that misreports exactly at the boundary you're trying to
tune is worse than no field.

**Fix.** `Delivery = if(variables('varAsync'),'Emailed','Link returned')`.

### B6. One country may have several providers — the workbook currently mixes them

The Order List has a `Provider` column, and `04` puts it in the protected identity block on every
sheet. But the export filters on **country only**. If a country uses two providers, one workbook
contains both providers' requests, and the admin sends provider A a file listing provider B's
customers, employee names and delivery addresses.

That is a data-sharing incident, not a bug.

**Fix, in order of preference:**

1. Group by `Provider` in the script and produce **one workbook per provider** (filename gains
   the provider, the log gains a row per file). Cleanest, and it matches how the file is actually
   used.
2. Add a Provider picker in PowerApps and filter server-side. Simplest to build.
3. If a country genuinely only ever has one provider, write that down as an explicit assumption
   in `00` — so the day it stops being true, someone finds the note.

**This is the one item in the review I would not build past without an answer.** See F2.

### B7. `Needs attention` and `Unmapped` tabs are shipped to the provider

`01` §4 says *"the provider never sees a half-formed request"* — but `03` §11 puts those rows in
tabs **inside the workbook the provider receives**. A provider opening `Needs attention` sees
requests they can't action and, reasonably, either actions them anyway or emails to ask.

**Fix.** Keep them out of the workbook entirely. Report them in three places the admin actually
reads: the Respond `message`, the async email, and the log's `Notes` (with the RequestIDs).
`Never drop it silently` is satisfied by reporting, not by shipping. If you'd rather keep them in
the file for convenience, at minimum make them hidden sheets like `_Meta` — but hidden is not
private, and a provider can unhide.

### B8. `empty()` does not catch whitespace

§9.1 uses `empty(triggerBody()?['text'])`. `empty(' ')` is `false`, so a country of one space
passes validation and produces `SIM_Country eq ' '` → zero rows → "No SIMs found for  ."

**Fix.** `empty(trim(triggerBody()?['text']))` on both text inputs. Trim before use, not just
before the check — build the filter from the trimmed value too.

Related: `equals()` and Switch cases are **case-sensitive**. `"requests"` from the app fails
validation with a clear message, which is acceptable — but normalising once
(`Set varExportType = toLower(trim(triggerBody()?['text_1']))`, lowercase Switch cases) removes a
whole class of "it worked in my test" reports.

---

## C. Simplifications that remove whole classes of bug

### C1. Don't build the file URL by string concatenation — SharePoint hands it to you

§9.4.3 assembles the URL from a hard-coded site path, a hard-coded library path, and
`replace(varFileName,' ','%20')`. That breaks if the library's *URL* differs from its *display
name* (very common — "SIM Exports" may live at `/SIMExports` or `/Shared Documents/…`), if the
site is ever moved or renamed, or on any character that needs encoding beyond a space.

`SharePoint — Create file` already returns the answer:

```
body('Create_export_file')?['{Link}']        → absolute URL, correctly encoded
body('Create_export_file')?['{Path}']        → server-relative path
body('Create_export_file')?['{Identifier}']  → use this for the Run script action
body('Create_export_file')?['ItemId']
```

**Fix.** `Set varFileUrl = body('Create_export_file')?['{Link}']`. Then the download URL is
`concat('https://deutschebank.sharepoint.com/sites/simri/_layouts/15/download.aspx?SourceUrl=',
encodeUriComponent(body('Create_export_file')?['{Path}']))`. One hard-coded string left instead
of three.

### C2. `Create sharing link` answers your open delivery question

`00` leaves the delivery mechanism open, correctly noting that `download.aspx` depends on the
recipient having read access to the library and that a permissions gap surfaces as an
uncatchable browser error.

The SharePoint connector's **"Create sharing link for a file or folder"** action solves exactly
this: run it on the created file with Link type `View` (or `Edit`) and scope `Organization`, and
return `body('Create_sharing_link')?['link']?['webUrl']`. The link carries its own access grant,
so library permissions stop mattering, the async email is a link that always works, and you can
drop the "grant read to everyone who will click a download link" prerequisite from §0 — one less
thing to get wrong per country rollout.

Two caveats: your tenant's external-sharing policy must permit organisation-scoped links (likely
fine, it's internal-only), and the link is *anonymous-within-the-org* — anyone with the URL can
open it. Given the file contains employee names and delivery addresses, prefer scope
`Organization` over `Anyone`, and pair it with E1.

Keep `download.aspx` as the in-app `Launch()` target if you like the forced-download behaviour;
use the sharing link for the email.

### C3. Threshold as an Integer variable

Covered in A1 — but the wider point: **`Compose` is for strings, `Initialize variable` is for
typed values.** Anything you will compare numerically should be an Integer variable.

### C4. `string(result('Scope_-_Main'))` may be enormous

`result()` returns an array of the results of **every action in the scope**, including the
`Get items` bodies and the `Select` outputs. On a 60,000-row inventory export that is tens of
megabytes of JSON being stringified into a SharePoint multi-line text field. It will either fail
the update or fill the column with an unreadable wall.

**Fix.** Extract just the failure:

```
substring(
  string(first(where(result('Scope_-_Main'), equals(item()?['status'],'Failed')))?['error']),
  0, 2000)
```

Wrap in `coalesce(…, 'Scope failed with no action-level error')` so a scope timeout — which
produces no failed child action — still writes something. Put the raw run link (you already have
`Compose_Flow_Identity`) next to it for the full detail.

### C5. Reference the created file by identifier, not by path

After `Create file`, referring to the new workbook by *path* in the Run script action can hit a
brief propagation delay and fail with "file not found" on fast runs. Pass
`body('Create_export_file')?['{Identifier}']` to the Excel actions instead. Same fix as C1, same
root cause: use what the connector returned.

---

## D. Your three open DECIDEs — my recommendations

### D1. Double handover (`01` §1) — stamp, but understand what it costs

**Recommendation: add `ExportedOn` (DateTime) + `ExportRunId` (Text), stamp after a successful
write.** Not a `Status` transition.

Reasoning: a status transition means extending the choice column and hunting down every view,
filter and flow that keys on `Approved` — including ones you don't own. Two new columns are
additive and break nothing. And `ExportRunId` does double duty: it's the same key the return-leg
import needs (`01` §9), so one change closes two gaps.

**But here is the consequence the spec doesn't yet account for.** Stamping means writing back to
every exported row. `SharePoint — Update item` inside an `Apply to each` is one API call per row,
against a connector limit of roughly 600 calls per 60 seconds. Two thousand rows on the
**synchronous** path — where the user is watching a spinner and PowerApps gives you 120 seconds —
will not finish. Stamping quietly makes the sync path async, which defeats the reason `00` chose
a threshold in the first place.

**Fix:** stamp with OData `$batch` via `Send an HTTP request to SharePoint` — 100 items per
changeset, so 2,000 rows is 20 calls and a few seconds. Chunk the row array with `chunk()` or
`skip`/`take`, build the batch body, post to `_api/$batch`. It is fiddlier to write than an
`Apply to each` but it is the difference between the sync path surviving and not.

Two more consequences to write down:

- **Stamp *after* the file is confirmed written**, never before. If the build fails after
  stamping, requests are marked exported and were never sent — the failure mode is worse than the
  one you're preventing.
- **Trigger concurrency.** `03` §0 says leave it OFF; `01` §6 says set it to 1 once stamping
  exists. Both can't hold. With stamping, two admins exporting the same country simultaneously
  both read the same unstamped rows and both hand them over. Note that **turning on trigger
  concurrency is irreversible** in Power Automate — the designer warns you and means it. Given
  that, I'd prefer a soft claim: check the Export Log for a `Running` Requests export on the same
  country within the last N minutes and reject with "an export for Romania is already in
  progress". Reversible, visible, and it doesn't queue inventory exports behind requests ones.

And keep the "Re-export" toggle you proposed — with a mandatory reason captured into the log.
The genuine case (provider lost the file) is real, and if the only way to do it is to hand-edit
the list, someone will hand-edit the list.

### D2. The missing date column (`04` §3) — add `EffectiveDate`

**Agreed, and for the reason you gave.** Reusing `StartDate` costs nothing today and produces a
terminated line with a populated activation date, which is a reporting trap. `EndDate` +
`EffectiveDate` is more precise but the precision buys nothing the `RequestType` column doesn't
already tell you — you always know what kind of request a row is, so you always know what its
effective date means.

One addition: **also add `ProviderNotes` (multi-line, plain text)**, unlocked on every sheet.
Providers always need to say something — "number ported, ICCID differs", "address invalid",
"line already terminated 03-07". Without a column for it they will write it in an email, and
the return-leg import will never see it. One column now saves a category of lost information.

Make both Text, matching `StartDate`, for the locale reason `04` already gives — and see B1 about
formatting the cells as Text so Excel doesn't reinterpret them.

### D3. Delivery mechanism (`00`, still open) — sharing link

See C2. `Create sharing link`, scope `Organization`, type `View`. It removes the permissions
dependency that is the actual source of the uncatchable browser error, and it works identically
on the sync and async paths, so you maintain one delivery mechanism rather than two.

---

## E. Worth adding

**E1. Retention on `/SIM Exports/Files`.** These workbooks contain employee names, GDIDs and
home-ish delivery addresses, and the library will accumulate one per export per country forever.
Apply a retention label or a policy that deletes after 90 days, and note it in `00`. At a bank
this will be asked about eventually; it is much easier to answer "90-day retention, here's the
policy" than to retrofit it across a library of several thousand files. Related: the Export Log
holds `ActionedBy_email` indefinitely — fine, but decide it deliberately.

**E2. An `Instructions` sheet, first tab, in the handover template.** What to fill, the
`dd-mm-yyyy` date format, "do not add, delete or reorder rows", "do not edit greyed columns",
"paste values only", who to send it back to, and the RunId. Costs an hour, and removes most of
the round-trip questions. It also gives the return-leg import a stable first sheet to ignore.

**E3. `DurationSeconds` (Number) on the Export Log.** `02` wants to know whether the threshold is
set sensibly; that question is unanswerable without timings.
`div(sub(ticks(utcNow()),ticks(variables('varStartedUtc'))),10000000)`. After a month you can set
the threshold from data instead of from a guess.

**E4. Alert on failure.** The catch scope logs and responds, but nobody is watching the log list.
Add a `Send an email` to a support address in `Scope - Catch` — or a second, scheduled flow that
runs the "Failures" and "Stuck runs" views each morning and mails a digest. The second is
better: it also catches the runs that reached neither terminal action, which are the ones `02`
correctly identifies as the interesting ones.

**E5. Use Excel tables (ListObjects) per sheet, not bare ranges.** `Table_NewSIM`,
`Table_Terminate`, etc. Data validation and number formats extend to new rows automatically, the
return-leg import can address columns by name instead of by letter, and the whole thing survives
someone inserting a column. The inventory side already does this (`Table_query`) — be consistent.

**E6. Implement the authorisation check (`01` §8) — with an honest note about its limits.** Yes,
build the `Country Admins` lookup; it is cheap and it stops the export becoming a whole-estate
exfiltration route. But write down what it does *not* do: `ActionedBy` is a parameter the caller
supplies, and a flow callable from the app is callable with any parameters by anyone the app is
shared with. There is no trustworthy caller identity on a PowerApps V2 trigger. So the check
raises the bar against casual misuse and gives you an audit trail — it is not an access control.
If you need a real one, the flow has to authenticate the caller itself, which is a different and
much larger design. Record the residual risk rather than implying it's closed.

**E7. Assert the template's shape before writing.** `01` §7 flags template drift as a silent
empty-column failure. Make the script compare the sheet's actual headers against its expected
list on startup and fail loudly with the difference. Same for `Limit Columns by View` — a column
added to the export but not to the view exports empty and errors nowhere. One assertion covers
both.

**E8. Verify the internal names on the new Export Log list after you create it.** `04` makes the
point beautifully for the Order List — don't lose it on the list you're about to build.
`Rows_Exported`, `Sheet_Breakdown`, `ActionedBy_email`: SharePoint sometimes encodes the
underscore as `_x005f_` depending on how the column was created, so the internal name can come
out as `Rows_x005f_Exported`. Same failure mode as `Request_x0020_Type` — writes nothing, errors
nowhere. Create them with plain names and rename, then confirm with:

```
_api/web/lists/getbytitle('SIM Export Log')/fields?$select=InternalName,Title&$filter=Hidden eq false
```

**E9. `Respond ready` has no message.** `varMessage` is set on the invalid, no-data and queued
paths but never on the success path, so `gblExport.message` is empty exactly when the user
succeeded. Add `Set varMessage ready` — `"Export ready: 47 requests across 3 sheets."` The
PowerApps snippet in `03` shows the message in a Notify for every branch except this one.

**E10. Stale cross-references in `02`.** The action-reference table at the top of `02` points at
sections that have since moved in `03`: `Compose_Flow_Identity` is cited as §2a but lives at §3,
`Compose_threshold` as §2c but lives at §4, `body('Create_log_item')` as §3 but lives at §7, and
`result('Scope_-_Main')` as §8, which is now `Set varLogItemId`. Harmless today because you wrote
both; actively misleading to whoever maintains this in a year. Since `02` opens by warning that
renaming an action breaks these expressions, the table is the one place that has to be right.

**E11. Timezone in the log Title.** `Title` uses `formatDateTime(varStartedUtc, …)` (UTC) while
the `Started` column renders in the site's regional settings. In Bucharest that's a three-hour
gap between the title and the column next to it, which reads as a bug. Either
`convertFromUtc(variables('varStartedUtc'),'GTB Standard Time','yyyy-MM-dd HH:mm')` or append
`UTC` to the title.

---

## F. Questions

Ordered by how much the answer changes the build.

**F1. Volume — is 10,000 approved requests per country real?**
It drives the chunking work in A7, the `$batch` stamping in D1, and the async path's existence.
If the realistic steady state is 20–200 approved requests per country and 10,000 is a
once-at-migration number, the Requests path can be synchronous and single-call, and a large part
of this review's complexity disappears. What's the actual current count of `Approved` rows in the
biggest country?

**F2. One provider per country, or several?** (B6 — the blocker.)
If several, do you want one file per provider, or a provider picker in the app?

**F3. Who sends the workbook to the provider — the admin, or the flow?**
`00` says "the local admin sends it to the country's provider". If that's fixed, the flow never
needs the provider's address and the sharing link is enough. If you'd want the flow to mail the
provider directly later, the Order List needs a provider-contact lookup and the design should
leave room for it now.

**F4. Has sending employee names, GDIDs and delivery addresses to an external provider been
cleared, and under what retention?**
Not a technical question, but it's the one that can stop the project after it's built. It also
determines E1 and whether `Requestedfor` should be a name or an anonymised identifier.

**F5. The two choice value sets** — `RequestType` (exact spelling, all values) and the
`OrderStatus` value meaning approved. You've already flagged these; they block the `typeMap` and
the filter. Your one-line query gets both:

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields
  ?$filter=InternalName eq 'RequestType' or InternalName eq 'OrderStatus'&$select=InternalName,Choices
```

**F6. Does `Transfer` exist as a `RequestType` value?**
`04`'s handover mapping defines a Transfer sheet, but the Order List's transfer-related column is
`TransferdTo` and your description mentions delegation separately. Confirm Transfer and Delegate
are distinct choice values and that Transfer is genuinely provider-facing (a transfer between two
employees on the same contract may be an internal-only change).

**F7. Can an admin cover more than one country?**
The trigger takes a single `Country`. If admins are regional, "export all my countries" becomes
an obvious request within a month, and it's much cheaper to make `Country` accept a list now
(`in` clauses in OData, or one file per country in a loop) than to retrofit it.

**F8. What does the current inventory export actually take for, say, 2,000 rows?**
Sets the threshold empirically rather than at a round number. If 2,000 rows takes 90 seconds you
are already too close to the 120-second PowerApps limit and the threshold should be nearer 500.

**F9. Should `simInventoryID` go to the provider at all?**
It's an internal surrogate key. The provider can't use it, and its only purpose on the sheet is
to survive the round trip. If so it belongs in `_Meta` or a hidden column, not in the visible
context block — `04`'s own allow-list principle argues for the narrowest possible external
surface.

---

## G. Appendix — after reading `SIM_Data_Validation_DEMO.xlsx`

Added after the template was shared. It changes two findings above and adds three.

**B1 and B2 were already solved — credit where it's due.** The template preformats `PhoneNr`,
`ICC_ID` and `IMEI` as Text (`@`), and its Readme states the 15-significant-digit problem more
precisely than I did. It also states outright that "Data Validation never fires on pasted data […]
Treat the colours as the real net." Both findings stand as *requirements for the new handover
template*, not as things you missed. The `ICC_Check` column even validates the Luhn check digit
and hard-errors when the cell holds a number rather than text.

**G1. Validation and conditional formatting stop at row 1966.** Every DV and CF range is capped
(`E3:E1966`, `C2:C1966`, `AB3:AB1966`). The inventory export targets 60,000 rows, so from row
1,967 onward there is no dropdown, no popup and no colour — and the Readme correctly identifies the
colours as the real enforcement. The formula columns are fine, because `RowErrors`, `HasError` and
`UploadGate` use structured references over `Table_query` and extend automatically. Note too that
the sync threshold is 2,000 and the formatting stops at 1,966, so even a synchronous export has 34
uncoloured rows. Extend the ranges to a deliberate ceiling and document that the gate, not the
colours, is the check beyond it.

**G2. `UploadGate` exists and the export flow ignores it.** `Config!J2` is a named range:
`=IF(COUNTIF(Table_query[HasError],"ERROR")=0,"OK","BLOCKED")`, with `UploadGate_ErrorCount` at
`J3`, and the Config sheet says "Power Automate should read J2 before writing to SharePoint". The
*export* can use it too: read it after writing and report the count. That turns every inventory
export into a free data-quality audit of that country's estate — Luhn checks, dial-code checks,
date checks, all already built and tested. One script call. It's the highest value-per-effort item
in this whole review, and it uses machinery you already own. Don't *block* on it; the admin may be
exporting precisely to see the bad rows. This is now §13 of the rewritten spec.

**G3. Row 2 validates differently from rows 3+.** `E2`'s DV formula contains `NOT(ISNUMBER($E2))`
— the numeric-ICCID guard. `E3:E1966`'s does not; it uses `AND(ISNUMBER(TRIM($E3&"")+0), …)`
instead. Same split on `U` (IMEI) and `G` (StartDate). Almost certainly an artifact of the table
having one data row when the DV was applied. Not fatal — `ICC_Check` still catches it on every row
— but two different rules for the same column is a thing nobody will remember in a year.

**G4. Housekeeping before this file goes to an external provider.** It carries a pinned Office
web-extension (`xl/webextensions/`, including a `claude.fileId` property), and
`docProps/core.xml` has `lastModifiedBy: Ilie Danut Mihai`. Strip both. And rename the file — it
is called `SIM_Data_Validation_DEMO.xlsx` and it is a production dependency of a flow.

**Also worth noting:** the writable columns in `Table_query` are **not contiguous** — A–S plus U
(IMEI), with T and V–AC holding the check formulas. Anything touching `columnsCsv` needs to know
that. And the Excel 2016/2019 compatibility constraint (INDEX/MATCH not XLOOKUP, no LET, no
TEXTJOIN) matters more for the handover template than the inventory one, because providers are
external and you have no idea what they're running.

---

## Priority

If I were building this Monday:

1. **B6 / F2** — settle the provider question. It changes the file's shape.
2. **A1, A3, A4, A5, B8** — an afternoon. Do them while writing the actions, not after.
3. **A2** — the async failure path. It's the one that fails silently in front of a user.
4. **A6, A7, B3** — the chunking and retry work. The largest missing piece, and A6's silent
   truncation is the highest-consequence defect in the review.
5. **B1** — Text-format the ICCID columns in the template. Ten minutes, prevents corrupted data
   reaching your inventory.
6. **D1** — stamping, with `$batch`. Financial cost, but it can follow the first working export.
7. **C1, C2** — simplifications; do them early, they only get harder once URLs are hard-coded in
   emails and app formulas.
8. Everything in E, in whatever order suits.

What stays as it is: the one-flow-with-a-parameter decision, the probe-then-decide pattern, the
sync/async split, the three-point logging, the allow-list approach to columns, the `_Meta` sheet,
`No data` as its own status, and the read-only default. Those are all right, and several of them
are the kind of thing that only looks obvious after someone has already made the other choice.
