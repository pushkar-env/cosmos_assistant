import { clipboard } from 'electron'
import { IPC } from '@shared/ipc'
import type { NotificationPayload } from '@shared/types'
import type { ToolSpec } from './ToolRegistry'
import type { SecretsService } from '../SecretsService'

/**
 * Secrets Vault tools for the agent. `secret_copy` retrieves a stored
 * secret the user asks for and places it on the OS clipboard so they can
 * paste it anywhere.
 *
 * SECURITY: the decrypted value is written to the clipboard inside the main
 * process and is NEVER returned to the model — the tool result contains only
 * the secret's name and a masked preview. So the plaintext key never enters
 * the LLM context, transcript, or provider request. `secret_copy` is marked
 * sensitive, so it goes through the approval card the first time (the user can
 * "Always allow" for frictionless use thereafter).
 */
export function secretsTools(secrets: SecretsService): ToolSpec[] {
  return [
    {
      def: {
        name: 'secret_copy',
        description:
          "Copy one of the user's stored secrets (API key, token, password, etc.) to the system clipboard so they can paste it. Use this whenever the user asks you to give / get / copy / fetch a specific saved credential — e.g. \"give me my OpenAI API key\", \"copy my database password\". Describe the wanted secret in `query` using the words the user used (service/name). The secret value is copied on the device and is never shown to you — you'll get back only the secret's name and a masked hint to confirm to the user which one was copied. If nothing matches, you'll get the list of stored names to offer.",
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'What secret to copy, in the user\'s words, e.g. "openai api key", "aws secret", "gmail password".'
            }
          },
          required: ['query']
        },
        sensitive: true
      },
      summary: (a) => `Copy secret "${String(a.query ?? '').slice(0, 60)}" to clipboard`,
      run: async (a, ctx) => {
        const query = String(a.query ?? '').trim()
        if (!query) return 'Ask the user which secret they want copied.'

        const matches = secrets.findByQuery(query)
        if (matches.length === 0) {
          const names = secrets.list().map((s) => s.label)
          if (names.length === 0) {
            return 'The Secrets vault is empty — the user has not stored any secrets yet. They can add one from the Secrets panel (Ctrl+Space → Open Secrets).'
          }
          return `No stored secret matches "${query}". Stored secrets: ${names
            .slice(0, 20)
            .join(', ')}. Ask the user which one they mean.`
        }

        const top = matches[0]
        if (top.locked) {
          return `The secret "${top.label}" is locked — it was encrypted under a different device profile and can't be decrypted here. Ask the user to re-enter it in the Secrets panel.`
        }

        const value = secrets.reveal(top.id)
        if (value == null) {
          return `Could not decrypt "${top.label}" on this device. Ask the user to re-enter it in the Secrets panel.`
        }

        clipboard.writeText(value)

        // visual confirmation in the HUD (so the user always sees when a
        // secret hits their clipboard)
        if (!ctx.win.isDestroyed()) {
          const payload: NotificationPayload = {
            title: 'Secret copied',
            body: `${top.label} (${top.preview}) is on your clipboard — paste with Ctrl+V.`,
            kind: 'success'
          }
          ctx.win.webContents.send(IPC.NOTIFY, payload)
        }

        const others =
          matches.length > 1
            ? ` Other matches you can ask for by name: ${matches
                .slice(1, 4)
                .map((m) => m.label)
                .join(', ')}.`
            : ''
        return `Copied "${top.label}" (${top.preview}) to the clipboard. Tell the user it's ready to paste with Ctrl+V.${others}`
      }
    },
    {
      def: {
        name: 'secret_list',
        description:
          "List the names of the user's stored secrets (never the values) — their label, category and service. Use to answer \"what API keys / passwords do I have saved?\" or to help pick the right one before calling secret_copy.",
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'list stored secrets',
      run: async () => {
        const list = secrets.list()
        if (list.length === 0) {
          return 'The Secrets vault is empty. The user can add secrets from the Secrets panel (Ctrl+Space → Open Secrets).'
        }
        const lines = list.map((s) => {
          const svc = s.service ? ` — ${s.service}` : ''
          const locked = s.locked ? ' [locked]' : ''
          return `• ${s.label} (${categoryName(s.category)})${svc}${locked}`
        })
        return `Stored secrets (values hidden):\n${lines.join('\n')}`
      }
    }
  ]
}

function categoryName(id: string): string {
  return id.replace(/-/g, ' ')
}
