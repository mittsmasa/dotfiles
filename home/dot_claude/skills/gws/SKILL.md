---
name: gws
description: |
  Google Workspace CLI (gws) to operate Gmail, Calendar, Drive, Sheets, Docs,
  Chat, Tasks, and cross-service workflows via Bash tool.

  **Proactive triggers (use this skill when):**
  - User mentions email, Gmail, inbox, triage, send mail, reply, forward
  - User mentions calendar, events, agenda, schedule, meeting, free/busy
  - User mentions Drive, files, folders, upload, download, share
  - User mentions Sheets, spreadsheet, append row, read range
  - User mentions Docs, document, write to doc
  - User mentions Chat, send message to space
  - User mentions Tasks, task list, overdue tasks
  - User mentions standup, meeting prep, weekly digest, workflow
  - User mentions "gws" or "Google Workspace"
  - Japanese triggers: "メール" "カレンダー" "予定" "ドライブ" "スプレッドシート"
    "ドキュメント" "タスク" "メール送って" "予定確認" "ファイル一覧" "スタンダップ"
---

# gws — Google Workspace CLI

Bash tool で `gws` コマンドを実行し Google Workspace を操作する。

## Security Rules

- **NEVER** output secrets (API keys, tokens) directly
- **ALWAYS** confirm with user before executing write/delete commands
- Prefer `--dry-run` for destructive operations first

## CLI Syntax

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

### Global Flags

| Flag | Description |
|------|-------------|
| `--format <FORMAT>` | `json` (default), `table`, `yaml`, `csv` |
| `--dry-run` | Validate locally without calling the API |

### Method Flags

| Flag | Description |
|------|-------------|
| `--params '{"key": "val"}'` | URL/query parameters |
| `--json '{"key": "val"}'` | Request body |
| `-o, --output <PATH>` | Save binary responses to file |
| `--upload <PATH>` | Upload file content (multipart) |
| `--page-all` | Auto-paginate (NDJSON output) |
| `--page-limit <N>` | Max pages (default: 10) |

### Shell Tips

- **zsh `!` expansion**: `Sheet1!A1` contains `!`. Use double quotes:
  ```bash
  gws sheets +read --spreadsheet ID --range "Sheet1!A1:D10"
  ```
- **JSON quoting**: Wrap `--params`/`--json` in single quotes:
  ```bash
  gws drive files list --params '{"pageSize": 5}'
  ```

## Gmail

### Read (safe)

```bash
gws gmail +triage                                    # Unread inbox summary
gws gmail +read --message-id <ID>                    # Read message body
gws gmail users messages list --params '{"q": "from:alice@example.com", "maxResults": 5}'
```

### Write (confirm with user)

```bash
gws gmail +send --to <EMAIL> --subject '<SUBJECT>' --body '<BODY>'
gws gmail +send --to <EMAIL> --subject '<SUBJECT>' --body '<HTML>' --html
gws gmail +send --to <EMAIL> --subject '<SUBJECT>' --body '<BODY>' --attach report.pdf
gws gmail +send --to <EMAIL> --subject '<SUBJECT>' --body '<BODY>' --draft  # Save as draft
gws gmail +reply --message-id <ID> --body '<BODY>'
gws gmail +reply-all --message-id <ID> --body '<BODY>'
gws gmail +forward --message-id <ID> --to <EMAIL>
```

### Watch (streaming)

```bash
gws gmail +watch  # Stream new emails as NDJSON
```

## Calendar

### Read (safe)

```bash
gws calendar +agenda                                 # Upcoming events
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-04-01T00:00:00Z", "maxResults": 10}'
gws calendar freebusy query --json '{"timeMin": "...", "timeMax": "...", "items": [{"id": "email"}]}'
```

### Write (confirm with user)

```bash
gws calendar +insert --summary '<TITLE>' --start '2026-04-02T10:00' --end '2026-04-02T11:00'
gws calendar +insert --summary '<TITLE>' --start '2026-04-02T10:00' --end '2026-04-02T11:00' --attendees 'a@ex.com,b@ex.com'
gws calendar events quickAdd --params '{"calendarId": "primary", "text": "Lunch with Alice tomorrow at noon"}'
```

## Drive

### Read (safe)

```bash
gws drive files list --params '{"pageSize": 10}'
gws drive files list --params '{"q": "name contains '\''report'\''", "pageSize": 5}'
gws drive files get --params '{"fileId": "<ID>", "fields": "name,mimeType,size,webViewLink"}'
gws drive files export --params '{"fileId": "<ID>", "mimeType": "application/pdf"}' -o output.pdf
```

### Write (confirm with user)

```bash
gws drive +upload --file ./report.pdf
gws drive files create --json '{"name": "New Folder", "mimeType": "application/vnd.google-apps.folder"}'
gws drive permissions create --params '{"fileId": "<ID>"}' --json '{"role": "reader", "type": "user", "emailAddress": "a@ex.com"}'
```

## Sheets

### Read (safe)

```bash
gws sheets +read --spreadsheet <ID> --range "Sheet1!A1:D10"
gws sheets +read --spreadsheet <ID> --range "Sheet1!A1:D10" --format table
```

### Write (confirm with user)

```bash
gws sheets +append --spreadsheet <ID> --range "Sheet1!A1" --json '{"values": [["Name", "Score"], ["Alice", 95]]}'
```

## Docs

### Write (confirm with user)

```bash
gws docs +write --document <ID> --body 'Text to append'
```

## Chat

### Write (confirm with user)

```bash
gws chat +send --space <SPACE_NAME> --body 'Hello team!'
```

## Tasks

### Read (safe)

```bash
gws tasks tasklists list
gws tasks tasks list --params '{"tasklist": "<ID>"}'
```

### Write (confirm with user)

```bash
gws tasks tasks insert --params '{"tasklist": "<ID>"}' --json '{"title": "New task", "due": "2026-04-05T00:00:00Z"}'
```

## Workflows (cross-service, read-only)

```bash
gws workflow +standup-report              # Today's meetings + open tasks
gws workflow +standup-report --format table
gws workflow +meeting-prep                # Next meeting: agenda, attendees, docs
gws workflow +weekly-digest               # This week's meetings + unread count
gws workflow +email-to-task --message-id <ID>  # Convert email to task (WRITE)
gws workflow +file-announce --file-id <ID> --space <SPACE>  # Announce file in Chat (WRITE)
```

## Discovering Unknown Commands

When the needed command is not listed above:

```bash
gws <service> --help                      # Browse resources and methods
gws schema <service>.<resource>.<method>  # Inspect method schema
```

## Auth & Troubleshooting

```bash
gws auth status   # Check authentication state
gws auth login    # Re-authenticate if expired
```
