# Global Order List — schema and handover mapping

List GUID `e390b86b-13bb-4655-b3e6-efd5bd068279`.

---

## Columns

| Display name | Type | Role in the export |
|---|---|---|
| `CountryName` | Single line of text | **Export filter.** Index this. |
| `OrderStatus` | Choice | **Export filter** — `Approved`. Index this. |
| `Request Type` | Choice | **Drives the tab.** Its values become the sheet names. |
| `GDID` | Single line of text | Employee identifier — goes to the provider |
| `Requested by` | Single line of text | The requester |
| `Requested for` | Single line of text | The beneficiary — distinct from the requester and the one the provider cares about |
| `PhoneNr` | Single line of text | **Provider fills** on New SIM; known already on other types |
| `ICCID` | Single line of text | **Provider fills** on New SIM and Swap |
| `IMEI` | Single line of text | Usually device-side, not provider |
| `StartDate` | Single line of text | **Provider fills** on New SIM |
| `SIMType` | Choice | eSIM / Physical — the current type |
| `newSimType` | Single line of text | Swap target type — known at request time |
| `Provider` | Single line of text | Which provider the sheet goes to |
| `Plan Name` | Single line of text | Current plan |
| `New Plan` | Single line of text | Change-plan target — known at request time |
| `VR Compatible` | Yes/No | |
| `Delivery Address` | Single line of text | Where the physical SIM ships |
| `Location` | Single line of text | |
| `simInventoryID` | Single line of text | Link back to the inventory row — the key for Terminate / Swap / Transfer / Change plan |
| `TransferdTo` | **Person or Group** | Transfer target |
| `LineManager` | Single line of text | |
| `Justification` | Single line of text | Internal — not for the provider |
| `Ticket_ID`, `Bulk_ID`, `NGCC_SNOW_TICKET_ID` | Single line of text | Reference numbers |
| `WorkHistory` | Multiple lines of text | Internal audit trail — **never export** |
| `ApprovalPlanJson` | Multiple lines of text | Internal — **never export** |

---

## Three things that change the design

### 1. `ICCID` here, `ICC_ID` in the inventory

The two lists name the same thing differently. Anything moving between them — the return-leg
import especially — needs an explicit mapping, and a copy-paste of the inventory field map will
silently write nothing.

### 2. `StartDate` is text, not a date

Same as the inventory workbook. Consistent, and it dodges Excel's locale parsing — but it means
the provider can type anything. The handover sheet gets the same `dd-mm-yyyy` validation the
inventory template already uses, so bad dates are caught at the point of typing.

### 3. There is no date column for anything except a start

`StartDate` is the only date field. But four of the five provider-facing request types need a
date back that isn't a start date:

| Type | What the provider returns | Column that should hold it |
|---|---|---|
| New SIM | activation date | `StartDate` ✔ exists |
| Terminate | termination date | **nothing** |
| Swap | changeover date | **nothing** |
| Transfer | transfer date | **nothing** |
| Change plan | effective date | **nothing** |

**DECIDE** — three options:

- **Add `EffectiveDate` (text)** to the Order List, used by every type except New SIM. One new
  column, unambiguous, and the return-leg import writes one field per type.
- **Reuse `StartDate` as a generic effective date.** No schema change, but a terminated line with
  a populated `StartDate` reads as an activation to anyone who wasn't in this conversation, and
  reporting on it becomes guesswork.
- **Add `EndDate` for Terminate and `EffectiveDate` for the rest.** Most precise, two columns.

I would add `EffectiveDate`. Reusing `StartDate` is the option that costs nothing today and
confuses someone in eighteen months.

---

## Handover sheet mapping

Provider-facing types only. `Delegate` is internal and never leaves the building.

Every sheet carries the same protected identity block, then type-specific context, then the
fill-in columns.

**Protected on every sheet:** `RequestID` (the item ID), `Request Type`, `GDID`,
`Requested for`, `Provider`, `Ticket_ID`

### New SIM

| Context (protected) | Provider fills (unlocked, validated) |
|---|---|
| `SIMType`, `Plan Name`, `VR Compatible`, `Delivery Address`, `Location` | `PhoneNr`, `ICCID`, `StartDate` |

### Terminate

| Context | Provider fills |
|---|---|
| `PhoneNr`, `ICCID`, `simInventoryID`, `Plan Name` | `EffectiveDate` *(pending the decision above)* |

### Swap

| Context | Provider fills |
|---|---|
| `PhoneNr`, `ICCID` (old), `SIMType` (current), `newSimType` (target), `simInventoryID`, `Delivery Address` | `ICCID` (new), `EffectiveDate` |

Two `ICCID` columns on one sheet — the old one protected, the new one blank and unlocked. Header
them **`Current ICCID`** and **`New ICCID`** so nobody has to guess.

### Transfer

| Context | Provider fills |
|---|---|
| `PhoneNr`, `ICCID`, `simInventoryID`, `TransferdTo` (display name), `Plan Name` | `EffectiveDate` |

`TransferdTo` is a **Person or Group** column — the only one on this list. Reading it gives an
object, so export `TransferdTo.DisplayName` (or `.Email`), never the raw field. On the return
leg, writing to it needs `TransferdToId` with a numeric user ID, not a display string.

### Change plan

| Context | Provider fills |
|---|---|
| `PhoneNr`, `ICCID`, `simInventoryID`, `Plan Name` (current), `New Plan` (target) | `EffectiveDate` |

---

## Never exported

`WorkHistory` and `ApprovalPlanJson` are internal. `Justification` and `LineManager` are internal
too — a provider has no use for why the request was raised or who approved it, and both may carry
free text nobody vetted for external sharing.

Worth a deliberate decision rather than an accident: the export should use an explicit allow-list
of columns, not "everything except". A column added to the list next year then defaults to *not*
being sent, which is the safe direction.

---

## Still needed

**Internal names.** The screenshot gives display names; expressions need internal names, and for
columns with spaces those are usually `Requested_x0020_by`, `Request_x0020_Type` and so on —
**usually**, but not reliably. SharePoint derives the internal name from whatever the column was
called when it was *created*, so a column created as `RequestType` and later renamed to
`Request Type` keeps `RequestType`. Guessing is how a field silently exports empty.

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$select=Title,InternalName,TypeAsString&$filter=Hidden eq false and ReadOnlyField eq false
```

**The `Request Type` choice values, exactly as spelled.** They become the tab names and the keys
in the script's `typeMap`. `New SIM` vs `New Sim` vs `New SIM Request` matters — an unmatched
value lands in the `Unmapped` tab.

**The `OrderStatus` value for approved** — `Approved`, or something longer like
`Approved by Line Manager`.
