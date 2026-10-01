import { useEffect, useRef, useState } from 'react';
import type { WorkspacePreferences } from '@repellet/shared';
import { panelDimensions } from '../workspaceState';
// Header (48px) plus status bar (24px); the real size is measured once the body mounts.
const chromeHeight = 72;
export function useWorkspaceLayout(saved: WorkspacePreferences, measureKey: unknown) {
  const [pane, setPane] = useState(saved.pane);
  const [showSidebar, setShowSidebar] = useState(saved.showSidebar);
  const [showPreview, setShowPreview] = useState(saved.showPreview);
  const [showTerminal, setShowTerminal] = useState(saved.showTerminal);
  const [leftWidth, setLeftWidth] = useState(saved.leftWidth);
  const [previewWidth, setPreviewWidth] = useState(saved.previewWidth);
  const [terminalHeight, setTerminalHeight] = useState(saved.terminalHeight);
  const [visited, setVisited] = useState(new Set(['files', saved.pane]));
  const bodyRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({
    width: window.innerWidth,
    height: window.innerHeight - chromeHeight,
  });
  useEffect(() => {
    setVisited((old) => new Set([...old, pane]));
  }, [pane]);
  useEffect(() => {
    const clamp = () => {
      setLeftWidth((v) => Math.min(v, Math.max(150, innerWidth * 0.35)));
      setPreviewWidth((v) => Math.min(v, Math.max(200, innerWidth * 0.45)));
      setTerminalHeight((v) => Math.min(v, Math.max(100, innerHeight * 0.6)));
    };
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => setSpace({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [measureKey]);
  // Clicking the active tool collapses the sidebar; any other tool opens it.
  function selectPane(name: string) {
    if (name === pane && showSidebar) setShowSidebar(false);
    else {
      setPane(name);
      setShowSidebar(true);
    }
  }
  function revealPane(name: string) {
    setPane(name);
    setShowSidebar(true);
  }
  const dimensions = panelDimensions(
    space.width,
    space.height,
    { explorer: leftWidth, preview: previewWidth, terminal: terminalHeight },
    showPreview,
    showTerminal,
  );
  return {
    pane,
    showSidebar,
    showPreview,
    setShowPreview,
    showTerminal,
    setShowTerminal,
    leftWidth,
    setLeftWidth,
    previewWidth,
    setPreviewWidth,
    terminalHeight,
    setTerminalHeight,
    visited,
    bodyRef,
    dimensions,
    selectPane,
    revealPane,
  };
}
