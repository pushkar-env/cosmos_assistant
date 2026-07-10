import type { ToolSpec } from './ToolRegistry'
import type { GitService } from '../GitService'

/**
 * Git + GitHub tools for the agent. They operate on the project workspace (or a
 * `path` subfolder). Auth for push/pull/clone/publish uses the connected GitHub
 * account; the token is injected in the main process and never reaches the LLM
 * or the terminal.
 */
export function gitTools(git: GitService): ToolSpec[] {
  const path = (a: Record<string, unknown>): string | undefined =>
    a.path ? String(a.path) : undefined

  return [
    {
      def: {
        name: 'git_status',
        description:
          'Show the git status of the project (current branch, staged/modified/untracked files, ahead/behind the remote). Call this before committing to see what will be included.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Subfolder repo (optional)' } }
        },
        sensitive: false
      },
      summary: () => 'git status',
      run: (a) => git.statusText(path(a))
    },
    {
      def: {
        name: 'git_diff',
        description: 'Show the diff of changes. Set staged:true to see what is staged for commit.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            staged: { type: 'boolean', description: 'Show staged changes instead of unstaged' }
          }
        },
        sensitive: false
      },
      summary: (a) => (a.staged ? 'git diff --cached' : 'git diff'),
      run: (a) => git.diff(path(a), a.staged === true)
    },
    {
      def: {
        name: 'git_log',
        description: 'Show recent commits (hash, date, author, message).',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            count: { type: 'number', description: 'How many commits (default 15)' }
          }
        },
        sensitive: false
      },
      summary: () => 'git log',
      run: (a) => git.log(path(a), a.count ? Number(a.count) : 15)
    },
    {
      def: {
        name: 'git_init',
        description: 'Initialize a new git repository in the project (or a subfolder).',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        sensitive: false
      },
      summary: () => 'git init',
      run: (a) => git.init(path(a))
    },
    {
      def: {
        name: 'git_branch',
        description:
          'List branches, or create/switch a branch. action: "list" | "create" | "switch"; provide name for create/switch.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'switch'] },
            name: { type: 'string' },
            path: { type: 'string' }
          },
          required: ['action']
        },
        sensitive: false
      },
      summary: (a) => `git branch ${String(a.action ?? '')} ${String(a.name ?? '')}`.trim(),
      run: (a) =>
        git.branch(String(a.action) as 'list' | 'create' | 'switch', a.name ? String(a.name) : undefined, path(a))
    },
    {
      def: {
        name: 'git_commit',
        description:
          'Stage and commit changes with a message. By default stages ALL changes (git add -A); set all:false to commit only what is already staged. Writes the commit as the connected GitHub identity.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Commit message' },
            all: { type: 'boolean', description: 'Stage all changes first (default true)' },
            path: { type: 'string' }
          },
          required: ['message']
        },
        sensitive: true
      },
      summary: (a) => `commit: ${String(a.message ?? '').slice(0, 60)}`,
      run: (a) => git.commit(String(a.message), a.all !== false, path(a))
    },
    {
      def: {
        name: 'git_push',
        description:
          'Push commits to the GitHub remote (origin). Sets the upstream automatically on the first push of a branch. Requires a connected GitHub account.',
        inputSchema: {
          type: 'object',
          properties: {
            setUpstream: { type: 'boolean', description: 'Force -u origin <branch>' },
            path: { type: 'string' }
          }
        },
        sensitive: true
      },
      summary: () => 'git push',
      run: (a) => git.push(path(a), a.setUpstream === true)
    },
    {
      def: {
        name: 'git_pull',
        description: 'Pull the latest changes from the GitHub remote (origin) into the current branch.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        sensitive: true
      },
      summary: () => 'git pull',
      run: (a) => git.pull(path(a))
    },
    {
      def: {
        name: 'git_set_remote',
        description: 'Set the origin remote URL for the repository (e.g. an existing GitHub repo to push to).',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' }, path: { type: 'string' } },
          required: ['url']
        },
        sensitive: false
      },
      summary: (a) => `origin → ${String(a.url ?? '')}`,
      run: (a) => git.setRemote(String(a.url), path(a))
    },
    {
      def: {
        name: 'git_clone',
        description: 'Clone a git repository into the project workspace. Uses the connected GitHub account for private repos.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Repo URL (https://github.com/owner/repo.git)' },
            dir: { type: 'string', description: 'Target folder name (optional)' }
          },
          required: ['url']
        },
        sensitive: true
      },
      summary: (a) => `git clone ${String(a.url ?? '')}`,
      run: (a) => git.clone(String(a.url), a.dir ? String(a.dir) : undefined)
    },
    {
      def: {
        name: 'github_publish',
        description:
          'Create a new GitHub repository under the connected account, wire it as origin, commit any pending work, and push. Use for "put this on my GitHub" / "publish this project".',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository name' },
            private: { type: 'boolean', description: 'Create as private (default true)' },
            description: { type: 'string' },
            path: { type: 'string' }
          },
          required: ['name']
        },
        sensitive: true
      },
      summary: (a) => `publish ${String(a.name ?? '')} to GitHub`,
      run: (a) =>
        git.publish(String(a.name), a.private !== false, a.description ? String(a.description) : undefined, path(a))
    }
  ]
}
