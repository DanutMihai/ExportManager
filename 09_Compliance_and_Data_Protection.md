# SIM Exports — data protection and compliance record

This flow takes employee personal data out of a controlled SharePoint list, puts it in a
spreadsheet, and hands that spreadsheet to a third party outside the bank. That is a processing
activity with a lawful-basis question attached, and it is worth having the answer written down
before someone asks for it under pressure.

**This document is a record for review, not an approval.** `00` open item **O4** is open until
Data Protection or Compliance signs off on §3 and §6. Nothing here is legal advice; it is a
description of what the system does and which controls exist, in the form those teams will ask
for it.

---

## 1. What data leaves the list, and what does not

### Requests export — the workbook that goes to a provider

| Field | Category | Why it goes |
|---|---|---|
| `RequestID` | internal identifier | the return-leg matching key |
| `RequestType` | operational | tells the provider what to do |
| `GDID` | **employee identifier** | the reference both sides use for the line |
| `Requested for` | **employee name** | the provider provisions a named line |
| `Provider` | operational | recipient confirmation |
| `Ticket_ID` | internal reference | traceability both ways |
| `PhoneNr`, `ICCID`, `SIMType`, `PlanName`, `NewPlan`, `newSimType` | **service data** | the line being changed |
| `DeliveryAddress` | **delivery address** | where a physical SIM ships |
| `Location` | operational | office / site |
| `simInventoryID` | internal surrogate key | round-trip only — see O5 |
| `TransferdTo` (display name) | **employee name** | the transfer target |
| `Country` (hidden) | operational | drives the dial-code validation |

### Deliberately excluded

| Field | Why it never leaves |
|---|---|
| `WorkHistory` | internal audit trail — free text, unvetted, and of no use to a provider |
| `ApprovalPlanJson` | internal approval routing |
| `Justification` | free text written by an employee about why they need a phone. Unvetted for external sharing, and a provider has no use for it |
| `LineManager` | a second named individual with no role in provisioning |
| `Requestedby` | ditto — the beneficiary is `Requestedfor` |
| `IMEI`, `Bulk_ID`, `NGCC_SNOW_TICKET_ID` | device-side or internal grouping |

### The control that makes this durable

The export uses an **explicit allow-list**, in two places: the Select map in `03` §11.4, and the
`Limit Columns by View` view in `08` §1.5. A column added to the Order List next year therefore
defaults to **not** being sent.

That direction matters more than it looks. An "everything except" design leaks by default: someone
adds a column holding, say, a personal mobile number or a medical accommodation note, and it
appears in the next workbook a supplier receives, with nobody having made a decision. Under an
allow-list, the same event produces nothing.

`DeliveryAddress` deserves a specific decision rather than an assumption. If home addresses are
ever used for shipping — and for remote workers they usually are — the field is a home address, and
`Requestedfor` next to it makes it identifiable. That is the single most sensitive column in the
file. Either confirm the field only ever holds office addresses, or record it explicitly as
home-address data in the processing record.

### Inventory export

Stays inside the bank. It carries the full inventory row for a country, which includes employee
names and identifiers, and it goes to the admin who requested it. Same retention (§2) and same
sharing scope (§3), but no third-party transfer question.

---

## 2. Retention

| Where | Policy | Why |
|---|---|---|
| `/SIM Exports/Files` | **delete after 90 days** | every file contains employee names, GDIDs and delivery addresses, and the library accumulates one per export per country indefinitely |
| SIM Export Log | keep; optionally delete `Completed` items older than 2 years | the log holds the *fact* of an export, not the data — it is the audit trail and it is what makes §4 answerable |
| The provider's copy | **outside your control** — see §3 | |

Apply the library policy when you create the library (`08` §1.6), not later. Retrofitting retention
across a library of several thousand files is a different and much worse job, and at a bank the
question "how long do you keep these" arrives eventually. "90 days, here is the policy" is a much
better answer than "we are looking into it".

**A consequence to expect rather than treat as a bug:** once a file expires, the `ExportFile` link
on its log row 404s. That is correct — the record of the export outlives the data it contained,
which is the point.

The log holds `ActionedBy_email` indefinitely. That is a work email in an audit trail and is
normally fine, but it should be a decision rather than an oversight.

---

## 3. The external transfer — the part that is not technically solved

**The flow does not send anything to the provider.** It produces a workbook and gives the admin an
organisation-scoped sharing link. The admin downloads the file and forwards it through whatever
channel the provider relationship already uses.

That has one immediate practical consequence and one compliance consequence.

**Practical: the provider cannot open the sharing link.** Scope `Organization` means the bank's
tenant, on purpose, because the file contains employee names and delivery addresses. If anyone
emails that URL to a supplier they will get an access-denied page and raise a ticket. The link is
for the admin. Say so in whatever admin training accompanies this.

**Compliance: the actual transfer is unmanaged.** Everything in this design — the allow-list, the
90-day retention, the org-scoped link, the audit log — controls the file up to the moment it
reaches the admin's download folder. After that it is an email attachment, and none of the controls
travel with it.

Which means these questions belong to a person, not to the flow:

| Question | Owner |
|---|---|
| Is there a contract / DPA with each provider covering employee personal data? | Vendor management |
| What is the approved channel for sending it — secure file transfer, encrypted mail, a portal? | Information Security |
| What is the lawful basis, and is it recorded in the processing register? | Data Protection |
| How long may the provider retain it, and is that in the contract? | Vendor management |
| Are any providers outside the EEA / UK, and if so what transfer mechanism applies? | Data Protection |
| Does `Requestedfor` need to be a name, or would a GDID alone work for provisioning? | Process owner |

That last one is the only one with a technical answer available, and it is worth asking: if the
provider can provision from `GDID` + `DeliveryAddress` without a name, removing `Requestedfor`
meaningfully reduces what leaves the bank for the cost of one line in the Select map. If they
cannot, record why.

**If the flow is ever changed to mail providers directly**, this section is what changes first:
the sharing link scope, the recipient lookup, the channel, and every question in the table above
becomes a build requirement rather than a process one.

---

## 4. Audit trail — what you can prove afterwards

For any export, from the SIM Export Log alone:

| Question | Answered by |
|---|---|
| Did an export happen, and when? | `Started`, `Finished`, `Status` |
| Who ran it? | `ActionedBy_email` |
| What data left, and how much? | `ExportType`, `Country`, `Rows_Exported`, `Sheet_Breakdown` |
| Where did the file go? | `ExportFile`, `Delivery` |
| Which specific requests were in it? | `ExportRunId` on the Order List rows, matching `RunId` |
| Was it a repeat send? | `ReExport` |
| Did anything not get sent, and why? | `Rows_Skipped`, `Notes` |
| Did anyone try to export a country they do not administer? | `Status = Unauthorised`, with the email and country attempted |
| Can a file found in someone's inbox be traced back? | `_Meta.RunId` in the workbook → `RunId` in the log |

The three that were not answerable in v2 and are now — `ReExport`, `Rows_Skipped` and
`Unauthorised` as its own status — are exactly the three an auditor asks about, because they are
the three that indicate something other than routine operation.

Power Automate run history expires after about 28 days. After that the log is the only record,
which is why `02` insists the log item is created **before** the work starts rather than written at
the end: a run that dies without reaching a terminal action still leaves evidence that it happened.

---

## 5. Residual risks — recorded, not closed

Written plainly, because a control described as stronger than it is will be relied on as if it
were.

### R1 — The authorisation check is not access control

`03` §10.2 validates `ActionedBy` against the requested country's Local Admin fields on the SIMRI
Country Matrix. But `ActionedBy` is a parameter
the **caller supplies**, and a flow callable from a PowerApps app is callable directly, with any
parameters, by anyone the app is shared with. There is no trustworthy caller identity on a
PowerApps V2 trigger.

So the check raises the bar against casual misuse and produces an audit trail of attempts. It does
not stop a determined user with app access from exporting any country's data.

*What closing it would take:* the flow authenticating the caller itself — an HTTP-triggered flow
behind Entra ID, or a custom connector with per-user auth. A different and much larger design.
*Compensating controls today:* the `Unauthorised` log status with a view over it, and the fact that
app sharing is itself managed.

### R2 — The file is uncontrolled after download

§3. Accepted by design, because the admin-forwards-it model was a deliberate choice. Mitigate
through process and contract, not through this flow.

### R3 — Provider-side data quality cannot be enforced

Excel data validation never fires on pasted data, on fill-down, or from a macro. Providers paste.
The check columns and conditional formatting in the handover template are **guidance**, not
enforcement, and the `ReturnGate` cell is a convenience.

*Consequence:* the return-leg import must revalidate every field server-side and reject per row.
It must not be designed on the assumption that the workbook enforced anything. This is written into
`00` and `01` §9 as well, because it is the assumption most likely to be quietly made.

### R4 — Organisation-scoped links are readable by anyone in the tenant who has the URL

An org-scoped sharing link does not check whether the recipient should see that country's data —
only that they are inside the bank. Forwarded internally, it grants access.

*Why it is still the right choice:* the alternative, `download.aspx`, depends on library
permissions and fails as an uncatchable browser error, which is worse for the user and no better
for the data. *Compensating control:* 90-day retention bounds the window, and the log records who
generated each link.

### R5 — A cancelled run can leave requests stamped but never sent

`03` §16.6 compensates when the flow fails. It cannot run if an administrator cancels the run
outright, because neither the catch scope nor the compensation executes.

*Detection:* `02`'s "Stuck runs" view. *Recovery:* `08` §7's manual stamp-clearing procedure, keyed
on `ExportRunId`. *Likelihood:* low, but the failure is silent and permanent if nobody looks — which
is precisely why the view and the runbook entry exist.

---

## 6. For the review conversation

If Data Protection or Compliance asks for one page, it is this:

- **What:** employee name, employee identifier, work phone number, SIM identifiers, plan, and a
  delivery address — one row per approved SIM request.
- **To whom:** one telecoms provider per country, as a spreadsheet forwarded by the country's local
  administrator.
- **Why:** the provider cannot provision, terminate, swap or transfer a line without knowing which
  line and, where hardware ships, where to send it.
- **Minimisation:** explicit allow-list in two independent places; approval rationale, line manager,
  internal audit history and internal ticket references are never included.
- **Retention at our end:** 90 days on the generated files; the audit log persists.
- **Retention at theirs:** contractual, not technical — §3.
- **Audit:** every export produces one immutable log row with who, what, when, how many and where,
  plus a run identifier stamped onto each request that was sent (§4).
- **Known gaps:** R1 (authorisation is a deterrent, not a control) and R2 (the file is uncontrolled
  once downloaded), both recorded above with what closing them would cost.

The honest summary is that the technical controls around the file are good and the controls around
the *transfer* are a process question that this design deliberately does not try to answer. Saying
that plainly is a better position than implying the sharing link secures something it does not.
