import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Up, Down } from "./icons";
import EditorContextMenu, {
  runEditorAction,
  type EditorContextMenuAction,
} from "./EditorContextMenu";
import { isContextMenuKey, type PopupMenuCloseDetail } from "./popupMenu";
import { invoke } from "@tauri-apps/api/core";
import { createNoteContentSession } from "../lib/noteContentSession";

export interface TextPanelHandle {
  flushPendingEdit: () => Promise<void>;
}

interface TextPanelProps {
  selectedNodeId: string | null;
  onSearchResultNavigation: (nodeId: string) => void;
  getAllNodeIds: () => string[];
  getNodeDataForSearch: (
    nodeId: string
  ) => Promise<{ content: string; label: string }>;
  isTreeFilterActive: boolean;
  onToggleTreeFilter: () => void;
  onSearchActivity: (
    isActive: boolean,
    foundNodeIds: string[],
    currentQuery: string
  ) => void;
}

interface SearchResult {
  nodeId: string;
  startIndex: number;
  endIndex: number;
  text: string;
  globalListIndex: number;
  isLabelMatch?: boolean;
}

const escapeHtml = (unsafe: string | undefined | null): string => {
  if (unsafe === null || typeof unsafe === "undefined") return "";
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const escapeLiteralRegex = (query: string): string =>
  query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SAVE_DEBOUNCE_MS = 500;

const TextPanel = forwardRef<TextPanelHandle, TextPanelProps>(({
  selectedNodeId,
  onSearchResultNavigation,
  getAllNodeIds,
  getNodeDataForSearch,
  isTreeFilterActive,
  onToggleTreeFilter,
  onSearchActivity,
}, ref) => {
  const syncFromSessionRef = useRef<() => void>(() => {});

  const sessionRef = useRef(
    createNoteContentSession(
      async (id, content) => {
        await invoke("update_node_content", { id, content });
      },
      {
        onNotify: () => {
          syncFromSessionRef.current();
        },
      },
    ),
  );

  const syncFromSession = useCallback(() => {
    const s = sessionRef.current.getSnapshot();
    setText(s.text);
    setIsLoading(s.isLoading);
    setSaveError(s.saveError);
    setLoadError(s.loadError);
  }, []);

  syncFromSessionRef.current = syncFromSession;

  const [text, setText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const highlightPaneRef = useRef<HTMLDivElement>(null);
  const restoreEditorAfterHighlightRef = useRef(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [currentHitIndex, setCurrentHitIndex] = useState<number | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [activeSearchQuery, setActiveSearchQuery] = useState<string>("");
  const [searchError, setSearchError] = useState<string | null>(null);

  const [showHighlighting, setShowHighlighting] = useState(true);
  const [editorMenu, setEditorMenu] = useState<{
    x: number;
    y: number;
    canCut: boolean;
    canCopy: boolean;
  } | null>(null);
  const searchGenerationRef = useRef(0);

  const flushPendingEdit = useCallback(async () => {
    try {
      await sessionRef.current.flush();
    } finally {
      syncFromSession();
    }
  }, [syncFromSession]);

  useImperativeHandle(ref, () => ({ flushPendingEdit }), [flushPendingEdit]);

  useEffect(() => {
    const session = sessionRef.current;
    const generation = session.beginLoad(selectedNodeId);
    syncFromSession();

    if (!selectedNodeId) {
      setSearchQuery("");
      searchGenerationRef.current += 1;
      setIsSearching(false);
      setCurrentHitIndex(null);
      setSearchResults([]);
      setActiveSearchQuery("");
      setSearchError(null);
      setShowHighlighting(true);
      onSearchActivity(false, [], "");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const content = await invoke<string>("get_node_content", {
          id: selectedNodeId,
        });
        if (cancelled) return;
        session.applyLoadResult(generation, selectedNodeId, content);
      } catch {
        if (cancelled) return;
        session.applyLoadFailure(generation);
      }
      syncFromSession();
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedNodeId, onSearchActivity, syncFromSession]);

  const nodeSpecificResults = React.useMemo(() => {
    if (!selectedNodeId || !activeSearchQuery || !isSearching) return [];
    return searchResults.filter((r) => r.nodeId === selectedNodeId);
  }, [searchResults, selectedNodeId, activeSearchQuery, isSearching]);

  const hasContentMatches = React.useMemo(() => {
    return nodeSpecificResults.some((match) => !match.isLabelMatch);
  }, [nodeSpecificResults]);

  const displayHighlightedContent =
    isSearching &&
    activeSearchQuery.trim() !== "" &&
    isTreeFilterActive &&
    selectedNodeId &&
    nodeSpecificResults.length > 0 &&
    hasContentMatches &&
    showHighlighting;

  const displayHighlightedContentRef = useRef(displayHighlightedContent);
  useEffect(() => {
    displayHighlightedContentRef.current = displayHighlightedContent;
  }, [displayHighlightedContent]);

  const clearSearch = useCallback(() => {
    searchGenerationRef.current += 1;
    setIsSearching(false);
    setCurrentHitIndex(null);
    setSearchResults([]);
    setActiveSearchQuery("");
    setSearchError(null);
    setShowHighlighting(true);
    if (textareaRef.current && !displayHighlightedContentRef.current) {
      const currentCursorPosition = textareaRef.current.selectionStart;
      textareaRef.current.setSelectionRange(
        currentCursorPosition,
        currentCursorPosition
      );
    }
    onSearchActivity(false, [], "");
  }, [onSearchActivity]);

  const exitHighlightingMode = useCallback(() => {
    setShowHighlighting(false);
    setCurrentHitIndex(null);
  }, []);

  const exitHighlightingModeFromKeyboard = useCallback(() => {
    restoreEditorAfterHighlightRef.current = true;
    exitHighlightingMode();
  }, [exitHighlightingMode]);

  useEffect(() => {
    if (displayHighlightedContent) {
      const active = document.activeElement;
      if (!active || active === document.body) {
        highlightPaneRef.current?.focus();
      }
      return;
    }
    if (!restoreEditorAfterHighlightRef.current) return;
    restoreEditorAfterHighlightRef.current = false;
    const textarea = textareaRef.current;
    if (textarea && !textarea.disabled) {
      textarea.focus();
    } else {
      searchInputRef.current?.focus();
    }
  }, [displayHighlightedContent]);

  const refreshSearchAfterEdit = useCallback(
    (newText: string) => {
      if (!isSearching || !activeSearchQuery.trim() || !selectedNodeId) return;

      const escapedQuery = escapeLiteralRegex(activeSearchQuery);
      const regex = new RegExp(escapedQuery, "gi");

      const otherResults = searchResults.filter(
        (r) => r.nodeId !== selectedNodeId
      );
      const freshMatches: SearchResult[] = [];
      let matchResult;
      while ((matchResult = regex.exec(newText)) !== null) {
        freshMatches.push({
          nodeId: selectedNodeId,
          startIndex: matchResult.index,
          endIndex: regex.lastIndex,
          text: matchResult[0],
          globalListIndex: 0,
          isLabelMatch: false,
        });
      }

      const combined = [...otherResults, ...freshMatches];
      combined.forEach((r, i) => (r.globalListIndex = i));

      setSearchResults(combined);

      onSearchActivity(
        true,
        combined.map((r) => r.nodeId),
        activeSearchQuery
      );

      if (currentHitIndex !== null) {
        if (currentHitIndex >= combined.length) {
          setCurrentHitIndex(combined.length > 0 ? 0 : null);
        }
      }
    },
    [
      isSearching,
      activeSearchQuery,
      selectedNodeId,
      searchResults,
      currentHitIndex,
      onSearchActivity,
    ]
  );

  const applyTextValue = useCallback(
    (newText: string) => {
      sessionRef.current.edit(newText);
      syncFromSession();
      if (isSearching) {
        exitHighlightingMode();
        refreshSearchAfterEdit(newText);
      }
      sessionRef.current.scheduleDebouncedSave(SAVE_DEBOUNCE_MS);
    },
    [exitHighlightingMode, isSearching, refreshSearchAfterEdit, syncFromSession]
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    applyTextValue(e.target.value);
  };

  const closeEditorMenu = useCallback((detail?: PopupMenuCloseDetail) => {
    setEditorMenu(null);
    if (detail?.reason === "dismiss" && detail.restoreFocus) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, []);

  const openEditorMenu = useCallback(
    (x: number, y: number, target: HTMLTextAreaElement) => {
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? 0;
      setEditorMenu({
        x,
        y,
        canCut: start !== end && !target.disabled,
        canCopy: start !== end,
      });
    },
    []
  );

  const handleTextareaContextMenu = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      event.stopPropagation();
      openEditorMenu(event.clientX, event.clientY, event.currentTarget);
    },
    [openEditorMenu]
  );

  const handleTextareaKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isContextMenuKey(event)) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openEditorMenu(rect.left, rect.bottom, event.currentTarget);
    },
    [openEditorMenu]
  );

  const handleEditorMenuAction = useCallback(
    async (action: EditorContextMenuAction) => {
      const target = textareaRef.current;
      closeEditorMenu();
      if (!target) return;
      await runEditorAction(action, target, applyTextValue);
    },
    [applyTextValue, closeEditorMenu]
  );

  useEffect(
    () => () => {
      sessionRef.current.cancelDebounce();
    },
    []
  );

  const getHighlightedHtml = useCallback(
    (
      fullContent: string,
      matchesInNode: SearchResult[],
      activeMatchGlobalIdx: number | null
    ): string => {
      if (!matchesInNode.length || !activeSearchQuery.trim()) {
        return escapeHtml(fullContent);
      }
      let resultHtml = "";
      let lastIndex = 0;
      const contentMatchesOnly = matchesInNode.filter(
        (match) => !match.isLabelMatch
      );
      if (contentMatchesOnly.length === 0) {
        return escapeHtml(fullContent);
      }

      const sortedMatches = [...contentMatchesOnly].sort(
        (a, b) => a.startIndex - b.startIndex
      );
      sortedMatches.forEach((match) => {
        resultHtml += escapeHtml(
          fullContent.substring(lastIndex, match.startIndex)
        );
        const isActive = match.globalListIndex === activeMatchGlobalIdx;
        const spanId = `search-match-${match.globalListIndex}`;
        const className = `search-match ${
          isActive ? "active-search-match" : ""
        }`.trim();
        resultHtml += `<span id="${spanId}" class="${className}">${escapeHtml(
          match.text
        )}</span>`;
        lastIndex = match.endIndex;
      });
      resultHtml += escapeHtml(fullContent.substring(lastIndex));
      return resultHtml;
    },
    [activeSearchQuery]
  );

  const activeMatchGlobalIndex = React.useMemo(() => {
    if (currentHitIndex !== null && searchResults[currentHitIndex]) {
      if (searchResults[currentHitIndex].nodeId === selectedNodeId) {
        return searchResults[currentHitIndex].globalListIndex;
      }
    }
    return null;
  }, [currentHitIndex, searchResults, selectedNodeId]);

  const highlightedTextDisplay = React.useMemo(() => {
    if (displayHighlightedContent) {
      return getHighlightedHtml(
        text,
        nodeSpecificResults,
        activeMatchGlobalIndex
      );
    }
    return null;
  }, [
    displayHighlightedContent,
    text,
    nodeSpecificResults,
    activeMatchGlobalIndex,
    getHighlightedHtml,
  ]);

  const handleDisplayClick = useCallback(() => {
    if (isSearching) {
      exitHighlightingMode();
    }
  }, [isSearching, exitHighlightingMode]);

  const isSearchGenerationCurrent = (searchId: number) =>
    searchId === searchGenerationRef.current;

  const performSearch = async () => {
    const queryToSearch = searchQuery.trim();
    if (!queryToSearch) {
      clearSearch();
      return;
    }

    const searchId = ++searchGenerationRef.current;
    setIsSearching(true);
    setShowHighlighting(true);
    setCurrentHitIndex(null);
    setSearchError(null);
    const newlyFoundResults: SearchResult[] = [];
    const allNodeIds = getAllNodeIds();

    try {
      if (!allNodeIds || allNodeIds.length === 0) {
        if (!isSearchGenerationCurrent(searchId)) return;
        setSearchResults(newlyFoundResults);
        setActiveSearchQuery(queryToSearch);
        onSearchActivity(true, [], queryToSearch);
        return;
      }
      let searchStartIndexInTree = 0;
      if (selectedNodeId) {
        const currentIndex = allNodeIds.indexOf(selectedNodeId);
        if (currentIndex !== -1) searchStartIndexInTree = currentIndex;
      }
      const orderedNodesToSearch = [
        ...allNodeIds.slice(searchStartIndexInTree),
        ...allNodeIds.slice(0, searchStartIndexInTree),
      ];

      const escapedQuery = escapeLiteralRegex(queryToSearch);
      const regex = new RegExp(escapedQuery, "gi");

      for (const nodeId of orderedNodesToSearch) {
        if (!isSearchGenerationCurrent(searchId)) return;

        const nodeData = await getNodeDataForSearch(nodeId);
        const nodeContent = nodeId === selectedNodeId ? text : nodeData.content;
        const nodeLabel = nodeData.label;

        let matchResult;
        while ((matchResult = regex.exec(nodeContent)) !== null) {
          newlyFoundResults.push({
            nodeId,
            startIndex: matchResult.index,
            endIndex: regex.lastIndex,
            text: matchResult[0],
            globalListIndex: newlyFoundResults.length,
            isLabelMatch: false,
          });
        }

        regex.lastIndex = 0;
        while ((matchResult = regex.exec(nodeLabel)) !== null) {
          newlyFoundResults.push({
            nodeId,
            startIndex: matchResult.index,
            endIndex: regex.lastIndex,
            text: matchResult[0],
            globalListIndex: newlyFoundResults.length,
            isLabelMatch: true,
          });
        }
      }

      if (!isSearchGenerationCurrent(searchId)) return;

      setSearchResults(newlyFoundResults);
      setActiveSearchQuery(queryToSearch);
      if (newlyFoundResults.length > 0) {
        navigateToHit(0, newlyFoundResults);
        onSearchActivity(
          true,
          newlyFoundResults.map((r) => r.nodeId),
          queryToSearch
        );
      } else {
        onSearchActivity(true, [], queryToSearch);
      }
    } catch (error) {
      if (!isSearchGenerationCurrent(searchId)) return;
      console.error("Search failed:", error);
      setSearchResults([]);
      setActiveSearchQuery(queryToSearch);
      setSearchError("Search failed");
      onSearchActivity(true, [], queryToSearch);
    }
  };

  const navigateToHit = useCallback(
    (index: number, resultsToUseParam?: SearchResult[]) => {
      const resultsToUse = resultsToUseParam || searchResults;
      if (
        resultsToUse.length === 0 ||
        index < 0 ||
        index >= resultsToUse.length
      ) {
        setCurrentHitIndex(null);
        return;
      }
      const hit = resultsToUse[index];
      setCurrentHitIndex(index);

      if (hit.nodeId !== selectedNodeId) {
        onSearchResultNavigation(hit.nodeId);
      }
    },
    [selectedNodeId, onSearchResultNavigation, searchResults]
  );

  useEffect(() => {
    if (
      displayHighlightedContent &&
      currentHitIndex !== null &&
      searchResults[currentHitIndex]?.nodeId === selectedNodeId
    ) {
      const hit = searchResults[currentHitIndex];
      if (hit && !hit.isLabelMatch) {
        setTimeout(() => {
          const spanId = `search-match-${hit.globalListIndex}`;
          const element = document.getElementById(spanId);
          element?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 50);
      }
    } else if (
      !displayHighlightedContent &&
      isTreeFilterActive &&
      textareaRef.current &&
      currentHitIndex !== null &&
      searchResults[currentHitIndex]?.nodeId === selectedNodeId
    ) {
      const hit = searchResults[currentHitIndex];
      if (
        hit &&
        !hit.isLabelMatch &&
        text &&
        hit.startIndex < text.length &&
        hit.endIndex <= text.length
      ) {
        textareaRef.current.setSelectionRange(hit.startIndex, hit.endIndex);
        try {
          const lineNum = text.substring(0, hit.startIndex).split("\n").length;
          const avgLineHeight = 18;
          textareaRef.current.scrollTop = Math.max(
            0,
            (lineNum - 5) * avgLineHeight
          );
        } catch (e) {}
      }
    }
  }, [
    text,
    currentHitIndex,
    searchResults,
    selectedNodeId,
    displayHighlightedContent,
    isTreeFilterActive,
  ]);

  const handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuery = e.target.value;
    setSearchQuery(newQuery);
    if (isSearching) {
      clearSearch();
    }
    if (!newQuery.trim()) {
      clearSearch();
    }
  };

  const prevFilterActiveRef = useRef(isTreeFilterActive);
  useEffect(() => {
    const wasJustEnabled = isTreeFilterActive && !prevFilterActiveRef.current;
    const wasJustDisabled = !isTreeFilterActive && prevFilterActiveRef.current;
    prevFilterActiveRef.current = isTreeFilterActive;

    if (wasJustEnabled && searchQuery.trim()) {
      performSearch();
    } else if (wasJustDisabled) {
      exitHighlightingMode();
      setCurrentHitIndex(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTreeFilterActive]);

  const handleSearchSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    performSearch();
  };

  const handleNextHit = () => {
    if (searchResults.length === 0) return;
    if (!showHighlighting) {
      setShowHighlighting(true);
    }
    const nextIndex =
      currentHitIndex === null
        ? 0
        : (currentHitIndex + 1) % searchResults.length;
    navigateToHit(nextIndex);
  };

  const handlePreviousHit = () => {
    if (searchResults.length === 0) return;
    if (!showHighlighting) {
      setShowHighlighting(true);
    }
    const prevIndex =
      currentHitIndex === null
        ? searchResults.length - 1
        : (currentHitIndex - 1 + searchResults.length) % searchResults.length;
    navigateToHit(prevIndex);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (
        isSearching &&
        searchQuery.trim() === activeSearchQuery &&
        searchResults.length > 0
      )
        handleNextHit();
      else performSearch();
    } else if (e.key === "Escape") clearSearch();
  };

  const editorDisabled =
    isLoading || !selectedNodeId || loadError !== null;

  return (
    <div
      className="text-panel"
      style={{ height: "100%", width: "100%" }}
    >
      <div className="editor-scroll-area">
        <div className="editor-column">
          {loadError ? (
            <p className="search-not-found" role="alert">
              {loadError}
            </p>
          ) : displayHighlightedContent && highlightedTextDisplay ? (
            <div
              ref={highlightPaneRef}
              className="highlighted-content-display"
              tabIndex={0}
              aria-label="Search highlights. Press Escape to return to editing."
              dangerouslySetInnerHTML={{ __html: highlightedTextDisplay }}
              onClick={handleDisplayClick}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  exitHighlightingModeFromKeyboard();
                }
              }}
            />
          ) : (
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              data-app-editor-menu=""
              value={text}
              onChange={handleTextChange}
              onContextMenu={handleTextareaContextMenu}
              onKeyDown={handleTextareaKeyDown}
              onClick={handleDisplayClick}
              placeholder={
                !selectedNodeId
                  ? "Select a note…"
                  : isLoading
                  ? "Loading…"
                  : "Start writing…"
              }
              disabled={editorDisabled}
              aria-invalid={saveError ? true : undefined}
            />
          )}
          {saveError && (
            <p className="search-not-found" role="alert">
              {saveError}
            </p>
          )}
        </div>
      </div>
      <div className="search-bar">
        <form
          onSubmit={handleSearchSubmit}
          style={{ display: "flex", alignItems: "center", flexGrow: 1, gap: "6px" }}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={handleSearchInputChange}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search… (Enter for next)"
            aria-label="Search notes"
          />
          <button
            type="submit"
            style={{ display: "none" }}
            aria-hidden="true"
          ></button>
        </form>
        <label className="filter-label">
          <input
            type="checkbox"
            id="treeFilterCheckbox"
            checked={isTreeFilterActive}
            onChange={onToggleTreeFilter}
          />
          Filter tree
        </label>
        <button
          type="button"
          className="toolbar-button"
          title="Previous Hit"
          aria-label="Previous match"
          onClick={handlePreviousHit}
          disabled={searchResults.length === 0}
        >
          <Up width={14} height={14} aria-hidden={true} />
        </button>
        <button
          type="button"
          className="toolbar-button"
          title="Next Hit"
          aria-label="Next match"
          onClick={handleNextHit}
          disabled={searchResults.length === 0}
        >
          <Down width={14} height={14} aria-hidden={true} />
        </button>
        {isSearching &&
          activeSearchQuery &&
          searchResults.length > 0 &&
          currentHitIndex !== null && (
            <span className="search-count" role="status" aria-live="polite">
              {`${currentHitIndex + 1}/${searchResults.length}`}
            </span>
          )}
        {isSearching &&
          activeSearchQuery &&
          searchResults.length === 0 &&
          activeSearchQuery.trim() !== "" && (
            <span className="search-not-found" role="status" aria-live="polite">
              {searchError ?? "Not found"}
            </span>
          )}
      </div>
      <EditorContextMenu
        open={editorMenu !== null}
        position={
          editorMenu ? { x: editorMenu.x, y: editorMenu.y } : null
        }
        canCut={editorMenu?.canCut ?? false}
        canCopy={editorMenu?.canCopy ?? false}
        canPaste={!editorDisabled}
        onAction={handleEditorMenuAction}
        onClose={closeEditorMenu}
      />
    </div>
  );
});

TextPanel.displayName = "TextPanel";

export default TextPanel;
