import { useState, useRef, useEffect, useCallback } from "react";
import {
  FluentProvider,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import Toolbar from "./components/Toolbar";
import TextPanel, { type TextPanelHandle } from "./components/TextPanel";
import TreeComponent from "./components/Tree";
import ExportToast from "./components/ExportToast";
import ConfirmDialog from "./components/ConfirmDialog";
import { deleteNode, exportBranch, sanitizeExportLabel } from "./lib/tree";
import { useTheme } from "./hooks/useTheme";
import { useEditorFont } from "./hooks/useEditorFont";
import { isEditorFontId } from "./lib/editorFonts";
import { useUiZoom } from "./hooks/useUiZoom";
import { openOptionsWindow } from "./lib/openOptions";
import { pickJsonExportPath, showMessage } from "./lib/dialogs";
import { joinExportPath } from "./lib/exportPath";
import {
  FLUSH_REQUEST_KEY,
  writeFlushResult,
  type FlushRequest,
} from "./lib/editorFlushBridge";
import { createNoteSelectionQueue } from "./lib/noteSelection";
import "./styles/theme.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Assuming TreeComponentHandle is implicitly imported or defined in Tree.tsx
// and App.tsx can infer it correctly. If not, we might need an explicit import type.
// For the ref, let's define the handle type explicitly for clarity if needed.
interface AppTreeComponentHandle {
  moveNodeUp: (id: string) => void;
  moveNodeDown: (id: string) => void;
  insertRootAfterSelected: (id: string | null) => void;
  insertChildFirst: (id: string) => void;
  hasChildren: (id: string) => boolean;
  getParentId: (id: string) => string | null;
  getNextSiblingId: (id: string) => string | null;
  getPreviousSiblingId: (id: string) => string | null;
  removeItemAndDescendants: (id: string) => void;
  ensureNodeIsOpen: (id: string) => void;
  getAllNodeIdsInOrder: () => string[];
  scrollNodeIntoView: (id: string) => void;
  getAllNodeIdsRecursive: () => string[];
  // clearFilter: () => void; // Removed as TreeComponent no longer has this method
}

function App() {
  const { resolvedTheme } = useTheme();
  const { setEditorFontFamily } = useEditorFont();
  useUiZoom();
  const [splitPosition, setSplitPosition] = useState(33.33);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  type LockStatus = "unknown" | "locked" | "open";
  const [lockStatus, setLockStatus] = useState<LockStatus>("unknown");
  const [lockPassword, setLockPassword] = useState("");
  const [lockError, setLockError] = useState("");
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startPosition = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const treeRef = useRef<AppTreeComponentHandle | null>(null);
  const textPanelRef = useRef<TextPanelHandle | null>(null);

  // State for tree filtering linked to TextPanel search
  const [isTreeFilterEnabled, setIsTreeFilterEnabled] = useState(false);
  const [treeFocusNodeIds, setTreeFocusNodeIds] = useState<Set<string> | null>(
    null
  );
  // New states for toolbar disabling logic
  const [isSearchUIVisible, setIsSearchUIVisible] = useState(false);
  const [currentSearchQueryInPanel, setCurrentSearchQueryInPanel] =
    useState("");
  const [rawMatchingNodeIdsSet, setRawMatchingNodeIdsSet] =
    useState<Set<string> | null>(null);
  const [exportToastMessage, setExportToastMessage] = useState<string | null>(
    null
  );
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const mainUiRef = useRef<HTMLDivElement>(null);

  const requestNodeSelect = useCallback(
    createNoteSelectionQueue(
      async () => {
        await textPanelRef.current?.flushPendingEdit();
      },
      (id) => {
        setSelectedNodeId(id);
      },
    ),
    [],
  );

  const SPLIT_MIN = 20;
  const SPLIT_MAX = 80;
  const SPLIT_STEP = 5;

  const handleNotebookSwitchRequest = useCallback(async (name: string) => {
    if (!name.trim()) return;
    try {
      await textPanelRef.current?.flushPendingEdit();
      await invoke("switch_notebook", { name });
      setSelectedNodeId(null);
      setIsTreeFilterEnabled(false);
      setTreeFocusNodeIds(null);
      setRawMatchingNodeIdsSet(null);
      setReloadKey((key) => key + 1);
      localStorage.setItem("treenote-db-switch-result", JSON.stringify({ ok: true, name, at: Date.now() }));
    } catch (error) {
      localStorage.setItem("treenote-db-switch-result", JSON.stringify({ ok: false, error: String(error), at: Date.now() }));
    }
  }, []);

  const handleBackupRestoreRequest = useCallback(async (timestamp: number) => {
    try {
      await textPanelRef.current?.flushPendingEdit();
      await invoke("restore_notebook_from_backup", { timestamp });
      setSelectedNodeId(null);
      setIsTreeFilterEnabled(false);
      setTreeFocusNodeIds(null);
      setRawMatchingNodeIdsSet(null);
      setReloadKey((key) => key + 1);
      localStorage.setItem(
        "treenote-backup-restore-result",
        JSON.stringify({ ok: true, timestamp, at: Date.now() }),
      );
    } catch (error) {
      localStorage.setItem(
        "treenote-backup-restore-result",
        JSON.stringify({ ok: false, error: String(error), at: Date.now() }),
      );
    }
  }, []);

  useEffect(() => {
    void Promise.all([invoke<{ password_configured: boolean }>("security_status"), invoke<{ editor_font_family: string }>("get_settings")])
      .then(([sec, settings]) => {
        setLockStatus(sec.password_configured ? "locked" : "open");
        const family = settings.editor_font_family || "system";
        if (isEditorFontId(family)) {
          setEditorFontFamily(family);
        }
      })
      .catch(() => {
        setLockStatus("locked");
        setLockError("Couldn't check the lock.");
      });
    const onStorage = (event: StorageEvent) => {
      if (event.key === "treenote-db-switch-request" && event.newValue) {
        try {
          const request = JSON.parse(event.newValue) as { name?: string; path?: string };
          if (request.name) void handleNotebookSwitchRequest(request.name);
        } catch {
          localStorage.setItem("treenote-db-switch-result", JSON.stringify({ ok: false, error: "Invalid notebook switch request.", at: Date.now() }));
        }
      }
      if (event.key === "treenote-backup-restore-request" && event.newValue) {
        try {
          const request = JSON.parse(event.newValue) as { timestamp?: number };
          if (typeof request.timestamp === "number") {
            void handleBackupRestoreRequest(request.timestamp);
          }
        } catch {
          localStorage.setItem(
            "treenote-backup-restore-result",
            JSON.stringify({ ok: false, error: "Invalid restore request.", at: Date.now() }),
          );
        }
      }
      if (event.key === FLUSH_REQUEST_KEY && event.newValue) {
        try {
          const request = JSON.parse(event.newValue) as FlushRequest;
          if (!request.requestId) return;
          void (async () => {
            try {
              await textPanelRef.current?.flushPendingEdit();
              writeFlushResult({
                requestId: request.requestId,
                ok: true,
                at: Date.now(),
              });
            } catch (error) {
              writeFlushResult({
                requestId: request.requestId,
                ok: false,
                error: "Couldn't save the current note.",
                at: Date.now(),
              });
            }
          })();
        } catch {
          /* ignore malformed flush request */
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [handleNotebookSwitchRequest, handleBackupRestoreRequest, setEditorFontFamily]);

  useEffect(() => {
    const checkBackups = () => {
      void (async () => {
        try {
          await textPanelRef.current?.flushPendingEdit();
          await invoke("run_scheduled_backup_if_due");
        } catch (error) {
          console.error("Scheduled backup check failed:", error);
        }
      })();
    };
    checkBackups();
    const interval = window.setInterval(checkBackups, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let unlistenClose: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await textPanelRef.current?.flushPendingEdit();
          const settings = await invoke<{ minimize_to_tray: boolean }>("get_settings");
          if (settings.minimize_to_tray) {
            const win = getCurrentWindow();
            await win.unminimize();
            await win.hide();
          } else {
            await invoke("quit_app");
          }
        } catch {
          /* save failed — window stays open; TextPanel shows error */
        }
      })
      .then((fn) => {
        unlistenClose = fn;
      });
    void listen("request-quit", async () => {
      try {
        await textPanelRef.current?.flushPendingEdit();
        await invoke("quit_app");
      } catch {
        /* save failed — keep running */
      }
    }).then((fn) => {
      unlistenQuit = fn;
    });
    return () => {
      unlistenClose?.();
      unlistenQuit?.();
    };
  }, []);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await invoke<boolean>("verify_password", { password: lockPassword });
    if (ok) { setLockStatus("open"); setLockPassword(""); setLockError(""); }
    else setLockError("Wrong password.");
  };

  useEffect(() => {
    const handleResize = () => {
      if (!isResizing.current) {
        isResizing.current = true;
        requestAnimationFrame(() => {
          isResizing.current = false;
        });
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const el = mainUiRef.current;
    if (!el) return;
    if (lockStatus === "locked") {
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
    } else {
      el.removeAttribute("inert");
      el.removeAttribute("aria-hidden");
    }
  }, [lockStatus]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".collapse-button")) return;
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startPosition.current = splitPosition;
  };

  const handleSplitterKeyDown = (e: React.KeyboardEvent) => {
    if (isCollapsed) return;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = splitPosition - SPLIT_STEP;
    else if (e.key === "ArrowRight") next = splitPosition + SPLIT_STEP;
    else if (e.key === "Home") next = SPLIT_MIN;
    else if (e.key === "End") next = SPLIT_MAX;
    else return;
    e.preventDefault();
    setSplitPosition(Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, next)));
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging.current) return;

    const deltaX = e.clientX - startX.current;
    const containerWidth =
      containerRef.current?.clientWidth || window.innerWidth;
    const deltaPercent = (deltaX / containerWidth) * 100;

    let newPosition = startPosition.current + deltaPercent;
    newPosition = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, newPosition));

    setSplitPosition(newPosition);
  };

  const handleMouseUp = () => {
    isDragging.current = false;
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isDragging.current) {
        handleMouseMove(e);
      }
    };

    const handleGlobalMouseUp = () => {
      if (isDragging.current) {
        handleMouseUp();
      }
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [splitPosition]);

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
    if (!isCollapsed) {
      startPosition.current = splitPosition;
    } else {
      setSplitPosition(
        startPosition.current > 0 ? startPosition.current : 33.33
      );
    }
  };

  const handleNodeSelect = (id: string) => {
    requestNodeSelect(id);
  };

  const handleMoveUp = () => {
    if (selectedNodeId && treeRef.current) {
      treeRef.current.moveNodeUp(selectedNodeId);
    }
  };

  const handleMoveDown = () => {
    if (selectedNodeId && treeRef.current) {
      treeRef.current.moveNodeDown(selectedNodeId);
    }
  };

  const handleNewTree = () => {
    if (treeRef.current) {
      treeRef.current.insertRootAfterSelected(selectedNodeId);
    }
  };

  const handleNewChild = () => {
    if (treeRef.current && selectedNodeId) {
      treeRef.current.insertChildFirst(selectedNodeId);
    }
  };

  const executeDelete = useCallback(async (targetId: string) => {
    if (!treeRef.current || isDeleting) return;

    const parentId = treeRef.current.getParentId(targetId);
    const nextSelectedId =
      treeRef.current.getNextSiblingId(targetId) ??
      treeRef.current.getPreviousSiblingId(targetId) ??
      parentId;

    setDeleteError(null);
    setIsDeleting(true);
    const success = await deleteNode(targetId);
    setIsDeleting(false);

    if (!success) {
      setPendingDeleteId(targetId);
      setDeleteError("TreeNote could not delete this note. Try again.");
      return;
    }

    treeRef.current?.removeItemAndDescendants(targetId);
    if (parentId) treeRef.current?.ensureNodeIsOpen(parentId);
    setSelectedNodeId(nextSelectedId);
    setPendingDeleteId(null);
    if (nextSelectedId) {
      window.setTimeout(() => {
        document.getElementById(`tree-item-${nextSelectedId}`)?.focus();
      }, 50);
    }
  }, [isDeleting]);

  const handleDelete = useCallback((nodeId?: string) => {
    const targetId = nodeId ?? selectedNodeId;
    if (!targetId || !treeRef.current || isDeleting) return;

    if (treeRef.current.hasChildren(targetId)) {
      setDeleteError(null);
      setPendingDeleteId(targetId);
      return;
    }

    void executeDelete(targetId);
  }, [executeDelete, isDeleting, selectedNodeId]);

  const handleExportNode = useCallback(async (nodeId: string) => {
    let label = "branch";
    try {
      const node = await invoke<{ label: string }>("get_node", { id: nodeId });
      label = node.label;
    } catch (error) {
      console.error("Failed to get node for export:", error);
    }
    const fileName = `${sanitizeExportLabel(label)}.json`;
    let defaultPath = fileName;
    try {
      const settings = await invoke<{ export_folder?: string }>("get_settings");
      defaultPath = joinExportPath(settings.export_folder || "", fileName);
    } catch {
      // Fall back to a filename-only default if settings cannot be read.
    }
    const path = await pickJsonExportPath(defaultPath);
    if (!path) return;
    try {
      await textPanelRef.current?.flushPendingEdit();
    } catch {
      await showMessage("Couldn't save the current note.", {
        title: "Export branch",
        kind: "error",
      });
      return;
    }
    const savedPath = await exportBranch(nodeId, path);
    if (!savedPath) {
      await showMessage("Failed to export branch.", {
        title: "Export branch",
        kind: "error",
      });
      return;
    }
    setExportToastMessage(`Exported branch to ${savedPath}.`);
  }, []);

  const getAllNodeIdsForSearch = useCallback((): string[] => {
    if (treeRef.current) {
      return treeRef.current.getAllNodeIdsRecursive();
    }
    return [];
  }, []);

  // New function that gets both node content and label for search
  const getNodeDataForSearch = useCallback(
    async (nodeId: string): Promise<{ content: string; label: string }> => {
      try {
        // Get both content and node info in parallel
        const [content, nodeInfo] = await Promise.all([
          invoke<string>("get_node_content", { id: nodeId }),
          invoke<{ label: string }>("get_node", { id: nodeId }),
        ]);
        return {
          content: content || "",
          label: nodeInfo?.label || "",
        };
      } catch (error) {
        console.error(`Failed to get data for node ${nodeId}:`, error);
        return { content: "", label: "" };
      }
    },
    []
  );

  const handleSearchResultNavigationInApp = useCallback((nodeId: string) => {
    requestNodeSelect(nodeId);
    if (treeRef.current) {
      let currentId = treeRef.current.getParentId(nodeId);
      while (currentId) {
        treeRef.current.ensureNodeIsOpen(currentId);
        currentId = treeRef.current.getParentId(currentId);
      }
      setTimeout(() => {
        treeRef.current?.scrollNodeIntoView(nodeId);
      }, 50);
    }
  }, [requestNodeSelect]);

  // Callback for TextPanel to toggle tree filter checkbox state
  const handleToggleTreeFilter = useCallback(() => {
    setIsTreeFilterEnabled((prev) => {
      const newIsEnabled = !prev;
      // If filter is being turned off, clear treeFocusNodeIds
      if (!newIsEnabled) {
        setTreeFocusNodeIds(null);
      }
      // If filter is being turned on AND a search is already active in TextPanel,
      // we might need to re-trigger the focusing logic.
      // For now, this simply toggles. TextPanel's next onSearchActivity will handle it.
      return newIsEnabled;
    });
  }, []);

  // Callback for TextPanel to report search activity
  const handleSearchActivity = useCallback(
    (
      isActive: boolean,
      foundNodeIdsAsArray: string[],
      currentQuery: string
    ) => {
      setIsSearchUIVisible(isActive);
      setCurrentSearchQueryInPanel(currentQuery);

      const activeSearch = isActive && currentQuery.trim() !== "";
      const currentFoundNodeIdsSet = activeSearch
        ? new Set(foundNodeIdsAsArray)
        : null;
      setRawMatchingNodeIdsSet(currentFoundNodeIdsSet);

      if (isTreeFilterEnabled && activeSearch && currentFoundNodeIdsSet) {
        setTreeFocusNodeIds(currentFoundNodeIdsSet);
      } else {
        setTreeFocusNodeIds(null);
      }
    },
    [isTreeFilterEnabled]
  );

  const activeSearchOverall =
    isSearchUIVisible && currentSearchQueryInPanel.trim() !== "";
  const isTreeCurrentlyFilteredReal =
    isTreeFilterEnabled && activeSearchOverall;
  const pendingDeleteIsTree =
    pendingDeleteId !== null &&
    treeRef.current?.getParentId(pendingDeleteId) === null;

  return (
    <FluentProvider theme={resolvedTheme === "dark" ? webDarkTheme : webLightTheme}>
      <div className="app-root">
        {(lockStatus === "unknown" || lockStatus === "locked") && (
          <div
            className="lock-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lock-title"
          >
            {lockStatus === "unknown" ? (
              <div className="lock-card">
                <h1 id="lock-title">TreeNote</h1>
                <p>Starting…</p>
              </div>
            ) : (
            <form className="lock-card" onSubmit={unlock}>
              <h1 id="lock-title">TreeNote locked</h1>
              <p>Enter your app-lock password. This does not encrypt your notebook file; anyone with filesystem access to it may be able to read it.</p>
              <input
                type="password"
                autoFocus
                value={lockPassword}
                onChange={(e) => setLockPassword(e.target.value)}
                placeholder="Password"
                aria-label="Password"
              />
              <button type="submit">Unlock</button>
              {lockError && (
                <span className="search-not-found" role="alert">
                  {lockError}
                </span>
              )}
            </form>
            )}
          </div>
        )}
        {lockStatus !== "unknown" && (
        <div ref={mainUiRef} className="main-ui">
        <ConfirmDialog
          open={pendingDeleteId !== null}
          title={
            deleteError
              ? "Couldn’t delete note"
              : `Delete this ${pendingDeleteIsTree ? "tree" : "branch"}?`
          }
          message={
            deleteError ??
            `This ${pendingDeleteIsTree ? "tree" : "branch"} and all of its descendants will be permanently deleted.`
          }
          confirmLabel={
            deleteError
              ? "Try again"
              : `Delete ${pendingDeleteIsTree ? "tree" : "branch"}`
          }
          cancelLabel={deleteError ? "Close" : "Cancel"}
          busy={isDeleting}
          onCancel={() => {
            setPendingDeleteId(null);
            setDeleteError(null);
          }}
          onConfirm={() => {
            if (pendingDeleteId) void executeDelete(pendingDeleteId);
          }}
        />
        <Toolbar
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          canMove={!!selectedNodeId}
          onNewTree={handleNewTree}
          onNewChild={handleNewChild}
          canNewChild={!!selectedNodeId}
          onDelete={() => void handleDelete()}
          canDelete={!!selectedNodeId}
          onOpenOptions={() => void openOptionsWindow()}
        />
        <div className="main-container" ref={containerRef}>
          <div
            id="tree-panel"
            className="tree-panel"
            style={{
              width: isCollapsed ? "0" : `${splitPosition}%`,
              height: "100%",
              minHeight: 0,
              transition: isCollapsed ? "width 0.3s ease" : "none",
              willChange: "width",
              transform: "translateZ(0)",
              display: isCollapsed ? "none" : "flex",
              flexDirection: "column",
            }}
          >
            {!isCollapsed && (
              <TreeComponent
                key={reloadKey}
                reloadKey={reloadKey}
                ref={treeRef}
                selectedNodeId={selectedNodeId}
                onNodeSelect={handleNodeSelect}
                onDeleteNode={(nodeId) => void handleDelete(nodeId)}
                onExportNode={handleExportNode}
                focusNodeIds={treeFocusNodeIds}
                isTreeCurrentlyFiltered={isTreeCurrentlyFilteredReal}
                allNodesWithSearchMatches={
                  isTreeCurrentlyFilteredReal ? rawMatchingNodeIdsSet : null
                }
                searchQuery={
                  isTreeCurrentlyFilteredReal ? currentSearchQueryInPanel : ""
                }
              />
            )}
          </div>
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize note tree"
            aria-valuemin={SPLIT_MIN}
            aria-valuemax={SPLIT_MAX}
            aria-valuenow={Math.round(splitPosition)}
            aria-valuetext={`${Math.round(splitPosition)} percent`}
            aria-controls="tree-panel"
            tabIndex={isCollapsed ? -1 : 0}
            onMouseDown={handleMouseDown}
            onKeyDown={handleSplitterKeyDown}
            data-collapsed={isCollapsed}
            style={{
              position: "absolute",
              left: isCollapsed ? "0" : `${splitPosition}%`,
              top: 0,
              height: "100%",
              zIndex: 2,
              willChange: "left",
              transform: "translateZ(0)",
            }}
          >
            <button
              type="button"
              className="collapse-button"
              onClick={toggleCollapse}
              onMouseDown={(e) => e.stopPropagation()}
              title={isCollapsed ? "Show Tree" : "Hide Tree"}
              aria-label={isCollapsed ? "Show Tree" : "Hide Tree"}
              aria-expanded={!isCollapsed}
              aria-controls="tree-panel"
              data-arrow={isCollapsed ? "▶" : "◀"}
            ></button>
          </div>
          <div
            style={{
              width: isCollapsed
                ? "100%"
                : `calc(${100 - splitPosition}% - 4px)`,
              height: "100%",
              minHeight: 0,
              transition: isCollapsed ? "width 0.3s ease" : "none",
              willChange: "width",
              transform: "translateZ(0)",
              position: "relative",
              marginLeft: isCollapsed ? "0" : "4px",
            }}
          >
            <TextPanel
              ref={textPanelRef}
              selectedNodeId={selectedNodeId}
              onSearchResultNavigation={handleSearchResultNavigationInApp}
              getAllNodeIds={getAllNodeIdsForSearch}
              getNodeDataForSearch={getNodeDataForSearch}
              isTreeFilterActive={isTreeFilterEnabled}
              onToggleTreeFilter={handleToggleTreeFilter}
              onSearchActivity={handleSearchActivity}
            />
          </div>
        </div>
        {exportToastMessage && (
          <ExportToast
            message={exportToastMessage}
            onDismiss={() => setExportToastMessage(null)}
          />
        )}
        </div>
        )}
      </div>
    </FluentProvider>
  );
}

export default App;
