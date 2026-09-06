import React from 'react';
import {
  FolderPlus,
  FilePlus,
  Pencil,
  Copy,
  Clipboard,
  ArrowUp,
  ArrowDown,
  Search } from
'lucide-react';
interface ToolbarButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}
function ToolbarButton({ icon, label, onClick }: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      className="group relative h-8 w-8 flex items-center justify-center rounded hover:bg-neutral-100 transition-colors"
      title={label}
      aria-label={label}>
      
      <div className="text-neutral-400 group-hover:text-neutral-700 transition-colors">
        {icon}
      </div>

      {/* Tooltip */}
      <div className="absolute top-full mt-1 px-2 py-1 bg-neutral-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
        {label}
      </div>
    </button>);

}
function ToolbarDivider() {
  return <div className="w-px h-4 bg-neutral-200" />;
}
export function MinimalToolbar() {
  return (
    <div className="h-12 border-b border-neutral-100 flex items-center px-4 gap-1 bg-white flex-shrink-0">
      <ToolbarButton
        icon={<FolderPlus size={16} />}
        label="New Tree"
        onClick={() => console.log('New Tree')} />
      
      <ToolbarButton
        icon={<FilePlus size={16} />}
        label="Add Note"
        onClick={() => console.log('Add Note')} />
      

      <ToolbarDivider />

      <ToolbarButton
        icon={<Pencil size={16} />}
        label="Rename"
        onClick={() => console.log('Rename')} />
      
      <ToolbarButton
        icon={<Copy size={16} />}
        label="Copy"
        onClick={() => console.log('Copy')} />
      
      <ToolbarButton
        icon={<Clipboard size={16} />}
        label="Paste"
        onClick={() => console.log('Paste')} />
      

      <ToolbarDivider />

      <ToolbarButton
        icon={<ArrowUp size={16} />}
        label="Move Up"
        onClick={() => console.log('Move Up')} />
      
      <ToolbarButton
        icon={<ArrowDown size={16} />}
        label="Move Down"
        onClick={() => console.log('Move Down')} />
      

      <ToolbarDivider />

      <ToolbarButton
        icon={<Search size={16} />}
        label="Search"
        onClick={() => console.log('Search')} />
      
    </div>);

}