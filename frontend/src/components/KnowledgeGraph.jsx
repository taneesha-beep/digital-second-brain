import React from 'react';
import GlobalGraph from './graph/GlobalGraph';

export default function KnowledgeGraph({ refreshTrigger, onNodeClick }) {
  return (
    <div key={refreshTrigger}>
      <GlobalGraph onNodeClick={onNodeClick} />
    </div>
  );
}
