# COSMOS Plugins — Format v1

Plugins extend the command palette declaratively. No plugin code runs inside
COSMOS — a plugin is data, and anything that executes a shell command goes
through the same confirmation flow as everything else.

## Install location

```
%APPDATA%\COSMOS\plugins\<your-plugin>\plugin.json
```

(In dev the userData folder is the same path — check the Vault → Audit tab
header or the palette "Open Settings" for the exact directory.)
Plugins load at startup; restart COSMOS after adding one.

## Manifest

```jsonc
// plugins/steam-tools/plugin.json
{
  "name": "steam-tools",
  "version": "1.0.0",
  "author": "you",
  "commands": [
    {
      "id": "open-steam",
      "title": "Open Steam",
      "keywords": ["game", "library"],
      "type": "app",            // launch executable by name/path
      "target": "steam"
    },
    {
      "id": "steam-status",
      "title": "Steam Server Status",
      "type": "url",            // open in default browser
      "target": "https://steamstat.us"
    },
    {
      "id": "flush-dns",
      "title": "Flush DNS Cache",
      "type": "shell",          // PowerShell — ALWAYS shows a confirmation
      "target": "Clear-DnsClientCache"
    }
  ]
}
```

## Rules

- `type: "url"` — target must be `http(s)://…`, opens in the OS browser.
- `type: "app"` — target is an executable name (resolved like Start → Run)
  or a full path.
- `type: "shell"` — target runs in PowerShell **only after the user confirms
  in the palette**, every time. There is no way for a plugin to bypass this.
- Max 50 commands per plugin. Invalid manifests are skipped (see the dev
  console for `[plugins]` log lines).

## Roadmap (v2+)

Planned extensions, in the order they'll land: theme contributions
(token maps), widget contributions, then sandboxed scripted plugins with a
permissioned API (voice intents, model providers). The manifest format is
versioned by the top-level fields only — v1 manifests will keep working.
