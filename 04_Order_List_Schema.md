# Global Order List — schema and handover mapping

List GUID `e390b86b-13bb-4655-b3e6-efd5bd068279` (environment variable `simri_OrderListId`).

**Decisions on this page are closed.** §3's three options were an open DECIDE in v2; the answer is
`EffectiveDate`, and `03_Export_Flow_Spec.md` §0 already lists it as a column to create. What is
still open lives only in `00_Design_Decisions.md` §Open items.

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
"simType":     "@{item()?['SIMType']?['Value']}"
"transferdTo": "@{item()?['TransferdTo']?['DisplayName']}"
"vrCompatible":"@{if(item()?['VRCompatible'],'Yes','No')}"
```

Without `?['Value']` a Choice column serialises as an object and lands in the sheet as
`[object Object]` or JSON. `VRCompatible` is a real Boolean, so `true`/`false` reaches the
provider unless converted — Yes/No is what a human expects.

`OrderStatus` is also a Choice column and needs the same treatment **if you ever export it**. The
map in `03` §11.4 does not: it is a filter, not handover data, and a provider has no use for it.
Listed here only so nobody adds it back without the `?['Value']`.

On the return leg, `TransferdTo` needs `TransferdToId` with a numeric user ID, never a display
name.

### One key in the map has no source column: `country`

```
"country": "@{variables('varCountry')}"
```

There is one country per export, so no Order List column carries it per row — but the handover
template's `IsPhoneValid` check compares a number's prefix against `tblCountries[DialCode]`
matched on a country value **on the row**. A hidden `Country` column on each sheet, populated from
this key by header matching, keeps the inventory template's formula reusable verbatim. Without it,
every phone number the provider types validates against nothing.

### One key is deliberately a string: `requestId`

`"requestId": "@{item()?['ID']}"` — the `@{…}` interpolation coerces it to text, and it must stay
that way. `03` §12.3 excludes skipped requests from stamping with
`contains(variables('varSkippedIds'), item()?['requestId'])`, and `contains()` on an array is an
exact match: `"1201"` does not match `1201`. Changing this to `int(item()?['ID'])` makes stamping
silently stop excluding anything, which means requests that were never sent get marked as sent.

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

**DECIDED: add `EffectiveDate` (Single line of text).** Used by every type except New SIM, which
keeps `StartDate`. Create it with the other three new columns in `03` §0.

The two rejected options, recorded so the question isn't reopened:

- **Reuse `StartDate` as a generic effective date.** No schema change, but a terminated line with
  a populated `StartDate` reads as an activation to anyone who wasn't in this conversation, and
  reporting on it becomes guesswork. It costs nothing today and confuses someone in eighteen
  months.
- **`EndDate` for Terminate plus `EffectiveDate` for the rest.** More precise, but the precision
  buys nothing `RequestType` doesn't already tell you — you always know what kind of request a row
  is, so you always know what its effective date means.

**Also add `ProviderNotes` (Multiple lines, plain text)**, unlocked on every sheet. Providers
always need to say something — "number ported, ICCID differs", "address invalid", "line already
terminated 03-07". Without a column for it they write it in an email and the return-leg import
never sees it. One column now saves a category of lost information.

Both are Text, matching `StartDate`, for the locale reason above — and both must be
**cell-formatted as Text (`@`)** in the template, or Excel reinterprets what the provider typed.

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
| `PhoneNr`, `ICCID`, `simInventoryID`, `PlanName` | `EffectiveDate`, `ProviderNotes` |

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

**The `RequestType` choice values, exactly as spelled** (`00` open item O1). They become the tab
names, the table names and the `type` keys in the script's `typeMap`. `New SIM` vs `New Sim` vs
`New SIM Request` matters.

An unmatched value no longer lands anywhere in the workbook: it comes back in the script's
`skipped` array as `unmapped:<value>`, is reported in the response, the email and the log, and is
**left unstamped** so the next export picks it up once the type is mapped. A wrong guess is
therefore visible and recoverable rather than a request that quietly never reaches a provider.

**The `OrderStatus` value for approved** (`00` open item O2) — `Approved`, or something longer like
`Approved by Line Manager`.

Both are choice *values*, which the schema dump doesn't include. Quickest way to get them:

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$filter=InternalName eq 'RequestType' or InternalName eq 'OrderStatus'&$select=InternalName,Choices
```
