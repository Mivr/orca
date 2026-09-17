import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SESSION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['sessions', 'snapshot'],
    summary: 'Capture a pre-restart witness of worktree→terminal→PTY→container→pid rows',
    usage: 'orca sessions snapshot [--file <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file'],
    notes: [
      'Read-only: calls terminal.list and worktree.ps only, so capturing a snapshot never disturbs agent flow.',
      'Take this before every orcad/daemon restart; check it back with `orca sessions verify --file <path>` after.'
    ],
    examples: ['orca sessions snapshot --file /tmp/opencode/sessions-before.json']
  },
  {
    path: ['sessions', 'verify'],
    summary: 'Diff live sessions against a pre-restart snapshot',
    usage: 'orca sessions verify --file <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file'],
    notes: [
      'Read-only: reports ok, reattached (same handle, new incarnation/pid), remapped (old→new handle), missing, and new rows.',
      'Exits non-zero when snapshot rows are missing after the restart.'
    ],
    examples: ['orca sessions verify --file /tmp/opencode/sessions-before.json']
  }
]
