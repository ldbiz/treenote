import React, { useEffect, useState } from 'react';
import { MinimalTree } from './components/MinimalTree';
import { MinimalEditor } from './components/MinimalEditor';
import { InvisibleSplitter } from './components/InvisibleSplitter';
import { KeyboardHint } from './components/KeyboardHint';
import { MinimalToolbar } from './components/MinimalToolbar';
export function App() {
  const [selectedNodeId, setSelectedNodeId] = useState('2-1');
  const [isTreeVisible, setIsTreeVisible] = useState(true);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      setWindowWidth(width);
      // Auto-hide tree on narrow windows
      if (width < 600) {
        setIsTreeVisible(false);
      } else {
        setIsTreeVisible(true);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  // Sample content for the selected note
  const noteContent = {
    '2-1': {
      title: 'Zen Garden App',
      content: `A digital space for cultivating calm and focus. The concept is simple: create an environment where thoughts can settle like sand in a zen garden.

The interface should feel like breathing—natural, effortless, invisible. No notifications, no counts, no metrics. Just space to think.

Key principles:
• Simplicity over features
• Calm over productivity
• Presence over efficiency

The design should honor the practice of mindfulness. Every interaction should feel intentional, never rushed. White space is not empty—it's room to breathe.`,
      isSaved: true
    }
  };
  const currentNote = noteContent[
  selectedNodeId as keyof typeof noteContent] ||
  {
    title: 'Untitled',
    content: 'Start writing...',
    isSaved: true
  };
  return (
    <div className="w-full h-screen bg-white flex flex-col overflow-hidden">
      <MinimalToolbar />

      <div className="flex-1 flex overflow-hidden">
        <MinimalTree
          isVisible={isTreeVisible}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId} />
        

        <InvisibleSplitter />

        <MinimalEditor
          title={currentNote.title}
          content={currentNote.content}
          isSaved={currentNote.isSaved} />
        
      </div>

      <KeyboardHint />
    </div>);

}