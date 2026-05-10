import React, { useMemo } from 'react';

const BASE_COMMANDS = [
  {
    id: 'todo',
    title: 'Todo List',
    aliases: ['todo', 'task', 'checkbox'],
    hint: 'Insert a checklist item',
    run: (editor) => {
      editor.insertBlock?.({
        type: 'checkListItem',
        content: [{ type: 'text', text: 'New todo item' }]
      });
    }
  },
  {
    id: 'table',
    title: 'Table',
    aliases: ['table', 'grid'],
    hint: 'Insert a 3x3 table',
    run: (editor) => {
      editor.insertBlock?.({
        type: 'table',
        content: {
          rows: 3,
          cols: 3
        }
      });
    }
  },
  {
    id: 'graph',
    title: 'Graph Link',
    aliases: ['graph', 'link', 'knowledge'],
    hint: 'Insert graph-reference placeholder',
    run: (editor) => {
      editor.insertBlock?.({
        type: 'paragraph',
        content: [{ type: 'text', text: '[[Graph: connect this note]]' }]
      });
    }
  }
];

function normalizeQuery(query = '') {
  return query.trim().replace(/^\//, '').toLowerCase();
}

function matchesQuery(command, normalizedQuery) {
  if (!normalizedQuery) return true;
  const values = [command.id, command.title, ...(command.aliases || [])]
    .join(' ')
    .toLowerCase();
  return values.includes(normalizedQuery);
}

export function getSlashCommands(query = '') {
  const normalized = normalizeQuery(query);
  return BASE_COMMANDS.filter((cmd) => matchesQuery(cmd, normalized));
}

export function runSlashCommand(commandId, editor) {
  const command = BASE_COMMANDS.find((cmd) => cmd.id === commandId);
  if (!command || !editor) return false;
  command.run(editor);
  return true;
}

export default function SlashMenu({ query = '', editor, onClose }) {
  const commands = useMemo(() => getSlashCommands(query), [query]);

  if (commands.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-500 shadow">
        No slash commands found
      </div>
    );
  }

  return (
    <div className="w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
      {commands.map((command) => (
        <button
          key={command.id}
          type="button"
          onClick={() => {
            runSlashCommand(command.id, editor);
            onClose?.();
          }}
          className="mb-1 w-full rounded-md px-3 py-2 text-left transition hover:bg-slate-100"
        >
          <p className="text-sm font-medium text-slate-800">/{command.id} - {command.title}</p>
          <p className="text-xs text-slate-500">{command.hint}</p>
        </button>
      ))}
    </div>
  );
}
