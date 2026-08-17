# SIMRI Country Matrix — schema and how the export uses it

List GUID `29bf3303-c195-474f-9146-e25d9f0d1b77`, on the same site. One item per country, holding
that country's configuration: provider, plan, SIM type, delivery defaults, and who administers it.

**The export flow reads this list for one thing: authorisation** (`03_Export_Flow_Spec.md` §10.2).
It already existed, so the `Country Admins` list that earlier drafts of `08` described building is
**not needed** — a second source of truth for who administers a country would have been a bug
waiting to happen.

Everything else below is recorded because it is the kind of detail that gets guessed wrong once and
costs an afternoon.

---

## Columns — internal names are authoritative

Confirmed from the field schema. **Do not infer an internal name from a display name here.** Ten of
these columns were created through the list UI and carry `field_N` internal names that have nothing
to do with what they display as.

| Internal name | Display name | Type | Used by the export |
|---|---|---|---|
| `Title` | Title *(shown as **CountryCode**)* | Text | – |
| `LinkTitle` | CountryCode | **Computed** | ✖ never filter on this |
| `field_1` | CountryName | Text | **filter** — matched against the trigger's `Country` |
| `field_3` | Provider | Text | – (see §"Provider" below) |
| `field_4` | Plan Name | Text | – |
| `field_5` | SIM Type | **Choice**: `eSIM`, `Physical SIM` | – |
| `field_9` | Preffered Option for VR Users | Text | – |
| `field_13` | Local Admin 1 | Text (email) | **authorisation** |
| `field_14` | Local Admin 2 | Text (email) | **authorisation** |
| `field_15` | Local Admin Group (optional) | Text (email) | **authorisation** |
| `VR_Compatible` | VR_Compatible | Yes/No | – |
| `ApprovalRequired` | Approval Required | Yes/No | – |
| `UseDefaultDeliveryAddress` | Use Default Delivery Address | Yes/No | – |
| `DefaultDeliveryAddress` | Default Delivery Address | Text | – |
| `Active` | Active | Yes/No | **filter** |
| `Periodofinventoryupdate` | Period of inventory update | Text | – |
| `FulfillmentType` | FulfillmentType | **Choice**: `Mail`, `API` | – |
| `Need_IMEI` | Need_IMEI | Yes/No | – |
| `Logo` | Logo | Text | – |
| `_ColorTag`, `ComplianceAssetId` | Color Tag, Compliance Asset Id | system | – |

Standard SharePoint fields (`ID`, `Created`, `Modified`, `Author`, `Editor`, `Attachments`, the
`_Compliance*` set) are present as usual and none of them are used here.

### Three traps in that table

**1. `Title` holds the country code; `LinkTitle` is only its display alias.**
`LinkTitle` is `SP.FieldComputed` — SharePoint's clickable mirror of `Title`. It is displayed as
*CountryCode*, which makes it look like the real column. **Computed fields cannot be filtered.**
`LinkTitle eq 'RO'` fails or returns nothing; the value lives in `Title`.

**2. Ten columns are `field_N`.** `field_1` is CountryName, `field_13`–`field_15` are the admins.
Nothing in the display name survives into the internal name. This is the same class of trap
`04_Order_List_Schema.md` opens with — there, a guess of `Request_x0020_Type` would have exported
empty without erroring. Here, a guess of `CountryName` would fail the same way.

**3. The typo in `field_9`'s display name is real** — *"Preffered Option for VR Users"*. Renaming
the display name is safe (the internal name is `field_9` regardless), so fix it if it bothers
anyone. Just do not assume the internal name follows.

---

## What the export does with it

### Authorisation — `03` §10.2

```
Filter: field_1 eq '@{variables('varCountryOData')}'
        and Active eq 1
        and (field_13 eq '@{variables('varActionedByOData')}'
          or field_14 eq '@{variables('varActionedByOData')}'
          or field_15 eq '@{variables('varActionedByOData')}')
Top Count: 1
```

Zero rows back → reject, log `Unauthorised`, terminate. One row back → proceed.

Five notes on that filter:

- **The parentheses matter.** Without them, OData precedence turns the whole thing into
  `(A and B and C) or D or E` — and any admin listed as Local Admin 2 for *any* country would pass
  for *every* country. It reads as a formatting nicety and is not one.
- **`Active eq 1`** keeps a decommissioned country out. Drop the clause if a country is ever marked
  inactive while its backlog is still being worked — but decide that deliberately, because the
  alternative is exporting data for a market the bank has left.
- **Both caller-supplied values are escaped** (`varCountryOData`, `varActionedByOData` — `03` §4a).
  An email will not normally contain an apostrophe, but `ActionedBy` is a parameter the caller
  controls, and an unescaped value can close the string and append its own clause — which would
  make the authorisation check pass unconditionally.
- **SharePoint's text comparison is case-insensitive**, so `Danut.Ilie@db.com` matches
  `danut.ilie@db.com`. That is what you want, since `User().Email` casing varies. Confirm it on the
  first run anyway (`08` §6 test 4) rather than relying on it.
- **No index needed.** One row per country is a few hundred items at most, far below the 5,000
  threshold. Indexing `field_1` costs nothing but buys nothing either.

**`field_15` — "Local Admin Group" — matches only an exact address.** It is a text column, so the
filter compares it to the caller's own email. If it holds a *shared mailbox* that someone actually
signs in as, that works. If it holds a **distribution list or an AAD group**, membership cannot be
evaluated in an OData filter at all — a member of the group will be rejected, and the fix is a
separate `Office 365 Groups — Check group membership` call after the row is fetched. Worth
confirming what is actually in that column for a country that uses it, because the failure is a
legitimate admin being told they are not authorised.

### What it does not do — and why that is a decision, not an omission

**`FulfillmentType = API` does not block a Requests export.** An API-fulfilled country provisions
automatically, so a provider handover workbook is not normally needed there — but the export is
allowed anyway, deliberately, so a manual fallback stays available when the API is down. Nothing in
the flow warns about it.

The consequence to be aware of rather than act on: if someone exports an API country and sends the
file, the same request can be ordered through two channels. `02`'s `ExportedOn` stamp still prevents
a *second export*, but it cannot know the API already ordered the line. If that ever happens for
real, the fix is one clause in §10.2's filter, or a warning appended to `varNotes` when
`FulfillmentType eq 'API'` — both cheap, and neither is built.

**`UseDefaultDeliveryAddress` needs no handling here.** When it is `No`, the PowerApps request form
prompts the user for an address, so every request reaches the Order List with `DeliveryAddress`
populated either way. The export's `missing:deliveryAddress` check on New SIM (`03` §17) therefore
behaves correctly with no country-level fallback. Recorded because the alternative — blank
addresses on requests in default-address countries — would have skipped every New SIM request in
those markets and produced no file at all.

---

## Provider — this list is why "one provider per country" is true

`00_Design_Decisions.md` records one provider per country as a confirmed assumption. It is not just
an assumption: **`field_3` is a single Provider value on a single row per country**, so the schema
enforces it. That is a stronger foundation than a verbal answer, and it is worth knowing which file
would have to change first if it ever stopped being true — `06_Handover_Template_Spec.md`, in its
closing section.

**One option worth considering, not currently built.** The handover workbook takes `Provider` from
each Order List row (`03` §11.4). Since the flow already fetches the matrix row for authorisation,
it could take the provider from `field_3` instead — one authoritative value per file rather than one
per request.

The argument for the current behaviour: a request approved before a provider change carries the
provider it was approved under, which is arguably the honest record. The argument against: the
workbook goes to whoever the country's provider is *today*, so a stale value in the identity block
tells the recipient they are looking at someone else's file. If provider changes are rare, leave it.
If one is coming, switch it before that export runs.

---

## Two consistency dependencies nobody will notice breaking

**`field_1` must match `CountryName` on the Global Order List and `SIM_Country` on the Global SIM
Inventory — exactly.** The export authorises against the matrix and then filters the Order List with
the same string. A country renamed in one list and not the other produces a clean "not authorised"
or a clean "no approved requests" — a correct-looking answer to a question nobody asked. As long as
the PowerApps country picker sources from this list and the other two lists were populated from it,
this holds; it is worth one check per new country rollout.

**The inventory template's `tblCountries` is a static copy of this list.**
`06_Handover_Template_Spec.md` §3 flags that the workbook's country dropdowns use
`Config!$A$2:$A$51` — a fixed 50-row range, because data validation rejects structured references.
**This** list is the source of truth; that sheet is a snapshot of it. Add the 51st country here and
it is silently absent from every dropdown in the template, and from the `DialCode` lookup that
`IsPhoneValid` depends on. Regenerating the Config sheet from this list should be part of adding a
country, not something remembered later.

---

## Fields worth using later, none of them now

Recorded so a future flow does not re-derive them:

| Field | What it could drive |
|---|---|
| `Periodofinventoryupdate` | a scheduled "this country's inventory is overdue" digest, alongside `02`'s failure digest |
| `Need_IMEI` | whether the return-leg import should require an IMEI for that country |
| `VR_Compatible` / `field_9` | which plan a VR user's request should default to |
| `ApprovalRequired` | whether a request skips the local-admin approval step entirely |
| `field_5` (SIM Type) | the country's *offered* SIM type — **not** the same as the Order List's `SIMType`, which is the type on a specific request. Do not conflate them |
