# Global Order List — schema and the Requests export column map

List GUID `e390b86b-13bb-4655-b3e6-efd5bd068279` (environment variable `simri_OrderListId`).

**Decisions on this page are closed.** What is still open lives only in `00_Design_Decisions.md`
§Open items.

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
| `RequestType` | Request Type | **Choice** | ✔ | Which of the five request kinds |
| `GDID` | GDID | Text | ✔ | Employee identifier |
| `Requestedby` | Requested by | Text | – | Internal |
| `Requestedfor` | Requested for | Text | ✔ | The beneficiary — what the provider needs |
| `PhoneNr` | PhoneNr | Text | ✔ | Populated on New SIM requests |
| `ICCID` | ICCID | Text | ✔ | Populated on New SIM and Swap requests |
| `IMEI` | IMEI | Text | – | Device-side |
| `StartDate` | StartDate | Text | ✔ | Populated on New SIM requests |
| `SIMType` | SIMType | **Choice** | ✔ | Current type |
| `newSimType` | newSimType | Text | ✔ | Swap target |
| `Provider` | Provider | Text | ✔ | Which provider the request is for |
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
recipient unless converted — Yes/No is what a human expects.

`OrderStatus` is also a Choice column and needs the same treatment **if you ever export it**. The
map in `03` §11.4 does not: it is a filter, not export data, and there's no use for it downstream.
Listed here only so nobody adds it back without the `?['Value']`.

### `CountryName` is a plain column, like every other

There is one country per export — the filter already guarantees every row shares it — but the
export still includes `CountryName` as an ordinary exported column, the same way the Inventory
export includes `SIM_Country`, rather than deriving it from the trigger's `Country` parameter. One
less special case in the Select map.

### `RequestID` is text, same as every other Select value

`"RequestID": "@{item()?['ID']}"` — `@{…}` string interpolation always produces text in a Select
map, regardless of the source column's underlying type. There's no special handling to remember
here (unlike the Choice/User/Boolean columns above); it's simply what the syntax does.

---

## Two things that change the design

### 1. `ICCID` here, `ICC_ID` in the inventory

The two lists name the same thing differently. Anything moving between them needs an explicit
mapping, and a copy-paste of the inventory field map will silently write nothing.

### 2. `StartDate` is text, not a date

Same as the inventory workbook. Consistent, and it dodges Excel's locale parsing — but it means
whatever's in this column round-trips as typed. No validation formula checks it on this flat
export, the same way none of the other columns are checked; `08` §6 test 10 is the closest thing to
a date-format check this design has, and it only covers ICCID.

---

## The Requests export column map

One flat `Select` (`03` §11.4), same shape for every row regardless of `RequestType` — no per-type
routing, no context-vs-fill-in distinction, since nothing is filled back in. A column is either in
the map or it isn't; where it doesn't apply to a given row's type, it's just blank.

| Excel header | Source | Populated for |
|---|---|---|
| `RequestID` | `ID` | every row |
| `RequestType` | `RequestType?['Value']` | every row |
| `CountryName` | `CountryName` | every row |
| `GDID` | `GDID` | every row |
| `Requestedfor` | `Requestedfor` | every row |
| `Provider` | `Provider` | every row |
| `Ticket_ID` | `Ticket_ID` | every row |
| `PhoneNr` | `PhoneNr` | New SIM |
| `ICCID` | `ICCID` | Terminate, Swap, Transfer, Change plan |
| `SIMType` | `SIMType?['Value']` | New SIM, Swap |
| `newSimType` | `newSimType` | Swap |
| `PlanName` | `PlanName` | New SIM, Terminate, Transfer, Change plan |
| `NewPlan` | `NewPlan` | Change plan |
| `VRCompatible` | `if(VRCompatible,'Yes','No')` | New SIM |
| `DeliveryAddress` | `DeliveryAddress` | New SIM, Swap |
| `Location` | `Location` | New SIM |
| `simInventoryID` | `simInventoryID` | Terminate, Swap, Transfer, Change plan |
| `TransferdTo` | `TransferdTo?['DisplayName']` | Transfer |
| `StartDate` | `StartDate` | New SIM |

`Delegate` rows never appear at all — excluded by the filter itself (`03` §10.3), not by any
per-row logic here.

---

## Never exported

`WorkHistory` and `ApprovalPlanJson` are internal. `Justification` and `LineManager` are internal
too — there's no use for why the request was raised or who approved it downstream, and both may
carry free text nobody vetted for external sharing.

Worth a deliberate decision rather than an accident: the export should use an explicit allow-list
of columns, not "everything except". A column added to the list next year then defaults to *not*
being sent, which is the safe direction.

---

## Still needed

✅ **Internal names — confirmed.** See the table above. Every guess would have been wrong.

**The `RequestType` choice values, exactly as spelled** (`00` open item O1). `03` §10.3's filter
compares `RequestType ne 'Delegate'` literally — `Delegate` vs `delegate` vs `Delegate request`
matters, and a mismatch means the exclusion silently does nothing rather than erroring.

**The `OrderStatus` value for approved** (`00` open item O2) — `Approved`, or something longer like
`Approved by Line Manager`.

Both are choice *values*, which the schema dump doesn't include. Quickest way to get them:

```
_api/web/lists(guid'e390b86b-13bb-4655-b3e6-efd5bd068279')/fields?$filter=InternalName eq 'RequestType' or InternalName eq 'OrderStatus'&$select=InternalName,Choices
```
