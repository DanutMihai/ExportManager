# The two template files — real metadata

Captured from `Get file properties` and `Get file metadata` on 19-08-2026. This is the
authoritative record of where the templates actually live and what they carry, replacing the
placeholder paths earlier drafts used.

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

## Requests handover template

**`Template Approved SIM Request.xlsx`** — the file the Requests export copies and fills for the
provider.

| Property | Value |
|---|---|
| List item ID | `626` |
| Path *(for `Get file content using path`)* | `/Shared Documents/SIMRI Templates/Template Approved SIM Request.xlsx` |
| `{FullPath}` | `Shared Documents/SIMRI Templates/Template Approved SIM Request.xlsx` |
| `{Identifier}` | `Shared%2bDocuments%252fSIMRI%2bTemplates%252fTemplate%2bApproved%2bSIM%2bRequest.xlsx` |
| `{Name}` | `Template Approved SIM Request` — **no extension** |
| `{FilenameWithExtension}` | `Template Approved SIM Request.xlsx` |
| `{DriveId}` | `b!nf9qtZJTV0-78d3OpNngLHm4hVngJLJJs38RvMarR4qQBGnO7DcOTK6CeGYWJKjy` |
| `{DriveItemId}` | `012MIYOHOPSYPGOASXZZA2OSZHQ5A3UTWK` |
| Sensitivity label | **For internal use only** · `af1741f6-9e47-426e-a683-937c37d4ebc5` |
| Size | 21,661 bytes |
| Created | 2026-07-22T08:34:57Z by Danut Ilie |
| Last modified | 2026-07-30T10:26:03Z |
| ETag | `{671E96CF-5702-41CE-A74B-278741BA4ECA},2` |

**This file already exists**, so `06_Handover_Template_Spec.md` describes work to be applied *to
it*, not a workbook to create from nothing. What is actually in it today is unknown from metadata
alone — 21 KB is consistent with either a near-empty scaffold or a partly-built template.

You do not need to audit it by hand. `assertTemplate()` runs on the first chunk and reports every
gap at once: missing tables, missing sheets, a table with the wrong number of data rows, a text
column that is not formatted `@`. Run one three-row export and read the error.

---

## Three things this metadata settles

### 1. The library display name is *Documents*; its URL is *Shared Documents*

Exactly the trap `03` §11.3 warns about when it says to take URLs from the connector rather than
building them. Everything path-based must use **`Shared Documents`**. Earlier drafts of this folder
used `/Documents/…`, which would have failed with a file-not-found that reads like a permissions
problem.

### 2. `{Identifier}` is double-encoded and must never be hand-built

```
Shared%2bDocuments%252fSIMRI%2bTemplates%252fTemplate%2bApproved%2bSIM%2bRequest.xlsx
```

`%2b` is `+`, which is a form-encoded space; `%252f` is a double-encoded `/`. So a space becomes
`+` becomes `%2b`, and a slash becomes `%2f` becomes `%252f`. Nobody is going to reproduce that
reliably by hand, and a file with spaces in its name — which this one has — is where an attempt
would go wrong.

Take it from `body('Get_template')` or `body('Create_export_file')?['{Identifier}']`. Same rule as
`{Link}` and `{Path}`.

`{DriveId}` + `{DriveItemId}` are also available and are the more robust pair for the Excel Online
**Run script** action if `{Identifier}` ever gives trouble — both templates sit on the same drive.

### 3. `{Name}` excludes the extension

`Update_Inventory_tetemplate`, not `Update_Inventory_tetemplate.xlsx`. Use
`{FilenameWithExtension}` when you want the whole thing. This flow does not depend on either —
`varFileName` is composed in `03` §6 — but it is the kind of thing that produces a file called
`something.xlsx.xlsx` when someone concatenates.

---

## The sensitivity label — verify this before you build anything else

**Both templates carry the label "For internal use only."** A file created from a labelled template
**inherits the label**, so every workbook this flow produces will carry it too.

That has two consequences, and the first one can stop the build.

### Can the flow read and write a labelled file at all?

It depends on whether the label applies **encryption**:

| Label configuration | What happens |
|---|---|
| Metadata / visual marking only | Everything works. The label rides along on the output file, which is what you want. |
| **Encryption enabled** | `Get file content` returns encrypted bytes, `Create file` produces a file the Excel connector cannot open, and **Excel Online → Run script fails**. The whole chunked-write design stops working. |

**Test this first — before the trigger, before the log list, before anything.** `08` §6 test 0.
It is a five-minute check: run `Get file content using path` on the handover template, `Create file`
into `/SIM Exports/Files`, then a trivial Run script against the copy. If the script opens the file,
you are clear. If it fails with a permissions or format error, the label is encrypted and the
design needs a different approach — most likely an exemption for the flow's service account, which
is an Information Security conversation with a lead time.

Do not discover this after building 130 actions.

### "For internal use only" — on a file that goes to an external provider

This is a policy conflict on the face of it, and it belongs to a person rather than to the flow.

The Requests workbook is *designed* to leave the bank: `00` records that the admin downloads it and
forwards it to the country's provider. A file labelled "For internal use only" being emailed to a
supplier is either a policy breach or a label that does not mean what its name suggests.

Three possible answers, and you need to know which one applies:

- **The label is advisory** and the process is accepted — then record it in `09` §3 as a known
  deviation with whoever accepted it.
- **The label carries a DLP rule** that blocks external sharing — then the admin's send will fail,
  probably silently from their point of view, and the handover process does not work at all.
- **The handover file should carry a different label** — one that permits controlled external
  sharing. Then the flow needs to set it, or the template needs to be relabelled, and the internal
  Inventory export keeps "For internal use only" while the Requests one does not.

The third is most likely the right answer and it is cheap to arrange *now*: relabel
`Template Approved SIM Request.xlsx` and every copy inherits correctly. Retrofitting it after
providers are receiving files means re-sending everything already sent.

`09` §3a carries this as an open compliance item. `00` open item **O4** does not close without it.

---

## `SIM_Data_Validation_DEMO.xlsx` is not one of these

Worth stating plainly, because earlier drafts of this folder confused the two.

`SIM_Data_Validation_DEMO.xlsx` — the file in this working folder — is the **validation-design
reference**. It is where the ICCID Luhn check, the dial-code check, the date check, the `RowErrors`
concatenation and the `UploadGate` pattern were worked out, and its Readme is the best explanation
of *why* those rules exist. `06` quotes it for that reason.

It is **not** a production dependency of this flow, and earlier instructions to "rename it because
DEMO in the name invites an accident" were aimed at the wrong file. Ignore them.

The consequence, and it is a real one: **`06`'s three criticisms of "the inventory template" were
derived from the DEMO file, not from `Update_Inventory_tetemplate.xlsx`.** Specifically —

- validation and conditional formatting capped at row 1966
- row 2 validating differently from rows 3 and below
- country dropdowns bound to a static `Config!$A$2:$A$51` range

Those may or may not be true of the production template. **Check them against
`Update_Inventory_tetemplate.xlsx` before acting on them**, because that is the file the export
actually writes 60,000 rows into, and the row-1966 cap is the one that matters at that volume.
