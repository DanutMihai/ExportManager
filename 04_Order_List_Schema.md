# Global Order List — schema and handover mapping

List GUID `e390b86b-13bb-4655-b3e6-efd5bd068279`.

---

## Columns — internal names are authoritative

Confirmed from the list schema. **No `_x0020_` anywhere** — every spaced column was created
without the space and renamed afterwards, so SharePoint kept the original internal name.
`Request_x0020_Type` does not exist and would have exported empty without erroring.

| Internal name | Display name | Type | Export? | Role |
|---|---|---|---|---|
| `Title` | Title | Text | – | |
| `CountryName` | CountryName | Text | filter | **Export filter.** Index. |
| `OrderStatus` | OrderStatus | **Choice** | filter | **Export filter** — approved. Index. |
| `RequestType` | Request Type | **Choice** | ✔ | **Drives the tab.** |
| `GDID` | GDID | Text | ✔ | Employee identifier |
| `Requestedby` | Requested by | Text | – | Internal |
| `Requestedfor` | Requested for | Text | ✔ | The beneficiary — what the provider needs |
| `PhoneNr` | PhoneNr | Text | ✔ | Provider **fills** on New SIM |
| `ICCID` | ICCID | Text | ✔ | Provider **fills** on New SIM and Swap |
| `IMEI` | IMEI | Text | – | Device-side |
| `StartDate` | StartDate | Text | ✔ | Provider **fills** on New SIM |
| `SIMType` | SIMType | **Choice** | ✔ | Current type |
| `newSimType` | newSimType | Text | ✔ | Swap target |
| `Provider` | Provider | Text | ✔ | Which provider gets the sheet |
| `PlanName` | Plan Name | Text | ✔ | Current plan |
| `NewPlan` | New Plan | Text | ✔ | Change-plan target |
| `VRCompatible` | VR Compatible | **Boolean** | ✔ | Render as Yes/No, not true/false |
| `DeliveryAddress` | Delivery Address | Text | ✔ | Where a physical SIM ships |
| `Location` | Location | Text | ✔ | |
| `simInventoryID` | simInventoryID | Text | ✔ | Link to the inventory row |
| `TransferdTo` | TransferdTo | **User** | ✔ | Transfer target |
| `LineManager` | LineManager | Text | – | Internal |
| `Justification` | Justification | Text | – | Internal, free text |
| `Ticket_ID` | Ticket_ID | Text | ✔ | Reference |
| `Bulk_ID` | Bulk_ID | Text | – | Internal grouping |
| `NGCC_SNOW_TICKET_ID` | NGCC_SNOW_TICKET_ID | Text | – | Internal reference |
| `WorkHistory` | WorkHistory | Note | ✖ **never** | Internal audit trail |
| `ApprovalPlanJson` | ApprovalPlanJson | Note | ✖ **never** | Internal |

### Four columns need special handling in the Select

Three Choice columns and one User column do **not** return plain strings:

```
"requestType": "@{item()?['RequestType']?['Value']}"
"orderStatus": "@{item()?['OrderStatus']?['Value']}"
"simType":     "@{item()?['SIMType']?['Value']}"
"transferdTo": "@{item()?['TransferdTo']?['DisplayName']}"
"vrCompatible":"@{if(item()?['VRCompatible'],'Yes','No')}"
```

Without `?['Value']` a Choice column serialises as an object and lands in the sheet as
`[object Object]` or JSON. `VRCompatible` is a real Boolean, so `true`/`false` reaches the
provider unless converted — Yes/No is what a human expects.

On the return leg, `TransferdTo` needs `TransferdToId` with a numeric user ID, never a display
name.

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

**Protected on every sheet:** `RequestID` (the item ID), `RequestType`, `GDID`,
`Requestedfor`, `Provider`, `Ticket_ID`

### New SIM

| Context (protected) | Provider fills (unlocked, validated) |
|---|---|
| `SIMType`, `PlanName`, `VRCompatible`, `DeliveryAddress`, `Location` | `PhoneNr`, `ICCID`, `StartDate` |

### Terminate

| Context | Provider fills |
|---|---|
| `PhoneNr`, `ICCID`, `simInventoryID`, `PlanName` | `EffectiveDate` *(pending the decision above)* |

### Swap

| Context | Provider fills |
|---|---|
| `PhoneNr`, `ICCID` (old), `SIMType` (current), `newSimType` (target), `simInventoryID`, `DeliveryAddress` | `ICCID` (new), `EffectiveDate` |

Two `ICCID` columns on one sheet — the old one protected, the new one blank and unlocked. Header
them **`Current ICCID`** and **`New ICCID`** so nobody has to guess.

### Transfer

| Context | Provider fills |
|---|---|
| `PhoneNr`, `ICCID`, `simInventoryID`, `TransferdTo` (DisplayName), `PlanName` | `EffectiveDate` |

`TransferdTo` is a **User** column — the only one on this list. Reading it gives an
object, so export `TransferdTo.DisplayName` (or `.Email`), never the raw field. On the return
leg, writing to it needs `TransferdToId` with a numeric user ID, not a display string.

### Change plan

| Context | Provider fills |
|---|---|
| `PhoneNr`, `ICCID`, `simInventoryID`, `PlanName` (current), `NewPlan` (target) | `EffectiveDate` |

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

✅ **Internal names — confirmed.** See the table above. Every guess would have been wrong.

**The `RequestType` choice values, exactly as spelled.** They become the tab names and the keys
in the script's `typeMap`. `New SIM` vs `New Sim` vs `New SIM Request` matters — an unmatched
value lands in the `Unmapped` tab.

**The `OrderStatus` value for approved** — `Approved`, or something longer like
`Approved by Line Manager`.

Both are choice *values*, which the schema dump doesn't include. Quickest way to get them:

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$filter=InternalName eq 'RequestType' or InternalName eq 'OrderStatus'&$select=InternalName,Choices
```
