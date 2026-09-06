import React, { useState } from 'react';
export function InvisibleSplitter() {
  const [isHovered, setIsHovered] = useState(false);
  return (
    <div
      className="w-1 flex-shrink-0 cursor-col-resize relative group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}>
      
      {/* Invisible hit area */}
      <div className="absolute inset-y-0 -left-2 -right-2 w-5" />

      {/* Visible line on hover */}
      <div
        className={`h-full w-px bg-neutral-200 transition-opacity duration-200 ${isHovered ? 'opacity-100' : 'opacity-0'}`} />
      
    </div>);

}