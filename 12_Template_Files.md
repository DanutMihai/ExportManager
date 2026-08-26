# The two template files — real metadata

The Inventory template's metadata below was captured from `Get file properties` and
`Get file metadata` on 19-08-2026 — this is the authoritative record of where it actually lives and
what it carries. The Requests template (`Requests_Export_Template.xlsx`) doesn't exist yet — it
needs to be built per `08` §1.7 — so its metadata section below is a placeholder to fill in once
that file exists, not a captured fact.

Both files sit in the **same library and folder**, on the same drive:

```
https://deutschebank.sharepoint.com/sites/simri/Shared Documents/SIMRI Templates/
```

---

## Inventory template

**`Update_Inventory_tetemplate.xlsx`** — the file the Inventory export writes into, and the same
file admins download and fill for the **import** flow.

| Property | Value |
|---|---|
| List item ID | `258` |
| Path *(for `Get file content using path`)* | `/Shared Documents/SIMRI Templates/Update_Inventory_tetemplate.xlsx` |
| `{FullPath}` | `Shared Documents/SIMRI Templates/Update_Inventory_tetemplate.xlsx` |
| `{Path}` | `Shared Documents/SIMRI Templates/` |
| `{Identifier}` | `Shared%2bDocuments%252fSIMRI%2bTemplates%252fUpdate_Inventory_tetemplate.xlsx` |
| `{Name}` | `Update_Inventory_tetemplate` — **no extension** |
| `{FilenameWithExtension}` | `Update_Inventory_tetemplate.xlsx` |
| `{DriveId}` | `b!nf9qtZJTV0-78d3OpNngLHm4hVngJLJJs38RvMarR4qQBGnO7DcOTK6CeGYWJKjy` |
| `{DriveItemId}` | `012MIYOHOUOI3LFGYDIFGJLYT6RM27EINL` |
| Content type | `Document` · `0x010100AC3DC870D98328428FA8CF6FAB691701` |
| Sensitivity | **For internal use only** |
| Size | 33,864 bytes |
| Last modified | 2026-08-05T10:07:04Z |
| ETag | `{B23672D4-039B-4C41-95E2-7E8B35F221AB},17` |

### The filename has a typo: `tetemplate`

Not `template`. It appears consistently in `Name`, `DisplayName`, `Path`, `{Identifier}` and
`{Link}`, so it is the real filename rather than a transcription slip.

**Leave it, or fix it deliberately — but do not half-fix it.** Renaming means updating
`simri_InventoryTemplate`, and — more importantly — checking whether admins have bookmarked the
current URL as their upload template. This one file serves both directions: the export writes into
a copy of it, and the import expects the workbook admins upload to match its shape. A rename that
breaks a bookmark breaks the import process, not just the export.

If you do rename it, do it once, before go-live, and update `08` §2.

---

## Requests template

**`Requests_Export_Template.xlsx`** — the file the Requests export copies and writes into. This
replaces the earlier five-sheet provider handover workbook design entirely: one plain Excel Table
(`Table_Requests`), headers matching `04_Order_List_Schema.md`'s column map, no protection, no
formula/check columns. Structurally the same shape as the Inventory template, just a different
table and column list.

**Build it, then capture its real metadata here** — list item ID, `Path`, drive IDs, size, the
sensitivity label actually applied — the same way the Inventory template's metadata above was
captured, once the file exists in SharePoint. Until then, treat every value in this subsection as
unknown rather than assumed.

Nothing here needs an equivalent of `assertTemplate()` — there's no per-type table/sheet structure
to validate at runtime any more. The one thing worth checking by hand before shipping: the `ICCID`
column is formatted Text (`@`), same reason as the Inventory template's `ICC_ID` column (`08` §6
test 10).

---

## Three things this metadata settles

### 1. The library display name is *Documents*; its URL is *Shared Documents*

Exactly the trap `03` §11.3 warns about when it says to take URLs from the connector rather than
building them. Everything path-based must use **`Shared Documents`**. Earlier drafts of this folder
used `/Documents/…`, which would have failed with a file-not-found that reads like a permissions
problem.

### 2. `{Identifier}` is double-encoded and must never be hand-built

*(from `Get file properties`/`Get file metadata` — see the note below on why this differs from
`Create file`'s own output)*

```
Shared%2bDocuments%252fSIMRI%2bTemplates%252fTemplate%2bApproved%2bSIM%2bRequest.xlsx
```

Kept as a real, captured illustration of the encoding trap even though this particular filename is
retired: `%2b` is `+`, which is a form-encoded space; `%252f` is a double-encoded `/`. So a space
becomes `+` becomes `%2b`, and a slash becomes `%2f` becomes `%252f`. Nobody is going to reproduce
that reliably by hand.

**This is a different action from the flow's own `Create file`, and the two do not share a schema.**
`Get file properties`/`Get file metadata` return bracketed keys like `{Identifier}`/`{Path}`/
`{Link}` — genuinely, confirmed here. The SharePoint **Create file** action used at `03` §11.3 does
**not**: its real output has only plain keys (`Id`, `Path`, `Name`, …, no `Link` at all), found
during testing by reading the action's actual raw output. So inside the flow, reference the
just-created file as `body('Create_export_file')?['Id']`, not `?['{Identifier}']` — that bracketed
form belongs to this document's metadata capture, not to the running flow.

`{DriveId}` + `{DriveItemId}` are also available from `Get file properties`/`Get file metadata` and
are the more robust pair for the Excel Online **Run script** action if `{Identifier}` ever gives
trouble — both templates sit on the same drive.

### 3. `{Name}` excludes the extension

`Update_Inventory_tetemplate`, not `Update_Inventory_tetemplate.xlsx`. Use
`{FilenameWithExtension}` when you want the whole thing. This flow does not depend on either —
`varFileName` is composed in `03` §6 — but it is the kind of thing that produces a file called
`something.xlsx.xlsx` when someone concatenates.

---

## The sensitivity label — verify this before you build anything else

**The Inventory template carries the label "For internal use only."** A file created from a labelled
template **inherits the label**, so every Inventory export will carry it too. The Requests
template's label is a choice to make when building it (`09` §3a), not yet a fact.

That has two consequences, and the first one can stop the build.

### Can the flow read and write a labelled file at all?

It depends on whether the label applies **encryption**:

| Label configuration | What happens |
|---|---|
| Metadata / visual marking only | Everything works. The label rides along on the output file, which is what you want. |
| **Encryption enabled** | `Get file content` returns encrypted bytes, `Create file` produces a file the Excel connector cannot open, and **Excel Online → Run script fails**. The whole chunked-write design stops working. |

**Test this first — before the trigger, before the log list, before anything.** `08` §6 test 0.
It is a five-minute check: run `Get file content using path` on the Inventory template, `Create
file` into `/SIM Exports/Files`, then a trivial Run script against the copy. If the script opens
the file, you are clear. If it fails with a permissions or format error, the label is encrypted and
the design needs a different approach — most likely an exemption for the flow's service account,
which is an Information Security conversation with a lead time. Repeat the same test against the
Requests template once it's built and labelled.

Do not discover this after building 130 actions.

### "For internal use only" — on a file that goes to an external provider

This is a policy conflict to avoid building in, not one to discover afterward — it belongs to a
person rather than to the flow.

The Requests export is *designed* to leave the bank eventually: `00` records that the admin
downloads it and forwards it to the country's provider. A file labelled "For internal use only"
being emailed to a supplier is either a policy breach or a label that does not mean what its name
suggests. Since the Requests template doesn't exist yet, the fix is to build it with the right
label from the start rather than relabel it later — full detail in `09` §3a.

`09` §3a carries this as an open compliance item. `00` open item **O4** does not close without it.

---

## `SIM_Data_Validation_DEMO.xlsx` is not one of these

Worth stating plainly, because earlier drafts of this folder confused the two.

`SIM_Data_Validation_DEMO.xlsx` — the file in this working folder — is the **validation-design
reference**. It is where the ICCID Luhn check, the dial-code check, the date check, the `RowErrors`
concatenation and the `UploadGate` pattern were worked out, and its Readme is the best explanation
of *why* those rules exist.

It is **not** a production dependency of this flow, and earlier instructions to "rename it because
DEMO in the name invites an accident" were aimed at the wrong file. Ignore them.

The consequence, and it is a real one: **three criticisms of "the inventory template" from earlier
review rounds were derived from the DEMO file, not from `Update_Inventory_tetemplate.xlsx`.**
Specifically —

- validation and conditional formatting capped at row 1966
- row 2 validating differently from rows 3 and below
- country dropdowns bound to a static `Config!$A$2:$A$51` range

Those may or may not be true of the production template. **Check them against
`Update_Inventory_tetemplate.xlsx` before acting on them**, because that is the file the export
actually writes 60,000 rows into, and the row-1966 cap is the one that matters at that volume.
