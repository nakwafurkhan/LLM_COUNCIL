import React, { memo } from 'react';

export const MODES = [
  { id: 'chat', label: 'Chat' },
  { id: 'quick', label: 'Quick' },
  { id: 'council', label: 'Council' },
  { id: 'code', label: 'Code + PR' },
  { id: 'humanize', label: 'Humanize' },
];

function Sidebar({
  mode,
  onMode,
  conversations,
  conversationId,
  onOpen,
  onDelete,
  onNew,
  onCollapse,
  config,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="wordmark">Council</span>
        <button
          type="button"
          className="icon-btn"
          onClick={onCollapse}
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          ⇤
        </button>
      </div>

      <button type="button" className="new-chat" onClick={onNew}>
        <span aria-hidden="true">+</span> New conversation
      </button>

      <div className="modes" role="group" aria-label="Mode">
        {MODES.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={mode === item.id}
            onClick={() => onMode(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="side-scroll">
        <div className="side-label">History</div>
        {conversations.map((conversation) => (
          <button
            type="button"
            key={conversation.id}
            className="hist"
            aria-current={conversation.id === conversationId}
            onClick={() => onOpen(conversation.id)}
          >
            <span className="hist-title">{conversation.title}</span>
            <span
              className="del"
              role="button"
              tabIndex={-1}
              title="Delete"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(conversation.id);
              }}
            >
              ×
            </span>
          </button>
        ))}
        {!conversations.length ? (
          <p className="dim" style={{ padding: '4px 8px', fontSize: 13 }}>
            Nothing saved yet.
          </p>
        ) : null}
      </div>

      {config ? (
        <div className="side-foot">
          <span>Mesh key {config.mesh_key_configured ? 'set' : 'missing'}</span>
          <span>GitHub {config.github_configured ? 'set' : 'missing'}</span>
        </div>
      ) : null}
    </aside>
  );
}

export default memo(Sidebar);
