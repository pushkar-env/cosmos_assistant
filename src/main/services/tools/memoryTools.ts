import type { MemoryCategory } from '@shared/types'
import type { ToolSpec } from './ToolRegistry'
import type { MemoryService } from '../MemoryService'

const CATEGORIES: MemoryCategory[] = ['preference', 'project', 'fact', 'goal']

export function memoryTools(memory: MemoryService): ToolSpec[] {
  return [
    {
      def: {
        name: 'memory_save',
        description:
          'Save a durable fact about the user to long-term memory (preferences, projects, goals, personal facts). Use when the user shares something worth remembering across conversations. Keep each memory one self-contained sentence.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'One self-contained sentence' },
            category: { type: 'string', enum: CATEGORIES }
          },
          required: ['content', 'category']
        },
        sensitive: false
      },
      summary: (a) => String(a.content ?? '').slice(0, 80),
      run: async (a) => {
        const category = CATEGORIES.includes(a.category as MemoryCategory)
          ? (a.category as MemoryCategory)
          : 'fact'
        const id = await memory.saveMemory(String(a.content), category)
        return `Remembered (#${id}).`
      }
    },
    {
      def: {
        name: 'memory_search',
        description:
          'Search long-term memory for saved facts about the user. Relevant memories are also auto-recalled each turn; use this for explicit lookups.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        },
        sensitive: false
      },
      summary: (a) => String(a.query ?? ''),
      run: async (a) => {
        const hits = await memory.recall(String(a.query), 8)
        if (hits.length === 0) return 'No matching memories.'
        return hits.map((m) => `#${m.id} [${m.category}] ${m.content}`).join('\n')
      }
    },
    {
      def: {
        name: 'note_write',
        description:
          'Create or update a note in the user\'s workspace (markdown welcome). Pass id to update an existing note, omit to create.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            title: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['title', 'content']
        },
        sensitive: false
      },
      summary: (a) => String(a.title ?? '').slice(0, 80),
      run: async (a) => {
        const id = memory.saveNote(
          typeof a.id === 'number' ? a.id : null,
          String(a.title),
          String(a.content)
        )
        return `Saved note #${id} "${String(a.title)}" — visible in the Workspace panel.`
      }
    },
    {
      def: {
        name: 'note_list',
        description: 'List the notes in the user\'s workspace.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'list notes',
      run: async () => {
        const notes = memory.listNotes()
        if (notes.length === 0) return 'No notes yet.'
        return notes.map((n) => `#${n.id} ${n.title} (updated ${n.updatedAt})`).join('\n')
      }
    },
    {
      def: {
        name: 'note_read',
        description: 'Read a workspace note by id.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id']
        },
        sensitive: false
      },
      summary: (a) => `#${Number(a.id)}`,
      run: async (a) => {
        const note = memory.getNote(Number(a.id))
        if (!note) return `No note #${Number(a.id)}.`
        return `# ${note.title}\n\n${note.content}`
      }
    },
    {
      def: {
        name: 'memory_delete',
        description: 'Delete a saved memory by its id (use when the user asks you to forget something).',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id']
        },
        sensitive: false
      },
      summary: (a) => `#${Number(a.id)}`,
      run: async (a) => {
        memory.deleteMemory(Number(a.id))
        return `Forgotten (#${Number(a.id)}).`
      }
    }
  ]
}
