import { DiffEditor } from '@monaco-editor/react';
import './CodeEditor';
export function CodeDiff({ original, modified }: { original: string; modified: string }) {
  return (
    <div className="git-diff-editor">
      <DiffEditor
        original={original}
        modified={modified}
        theme="repellet"
        options={{
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          minimap: { enabled: false },
        }}
      />
    </div>
  );
}
