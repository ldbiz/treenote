import React, { useState } from 'react';
interface MinimalEditorProps {
  title: string;
  content: string;
  isSaved: boolean;
}
export function MinimalEditor({ title, content, isSaved }: MinimalEditorProps) {
  const [editorContent, setEditorContent] = useState(content);
  return (
    <div className="flex-1 bg-white relative overflow-hidden">
      {/* Save status dot */}
      <div className="absolute top-6 right-6 z-10">
        <div
          className={`w-2 h-2 rounded-full ${isSaved ? 'bg-emerald-500' : 'bg-orange-500'}`}
          title={isSaved ? 'Saved' : 'Unsaved changes'} />
        
      </div>

      {/* Editor area */}
      <div className="h-full overflow-y-auto px-16 py-12">
        <div className="max-w-3xl mx-auto">
          {/* Title as first line */}
          <h1
            className="text-xl font-semibold mb-6 text-neutral-900 outline-none border-none"
            style={{
              fontFamily: 'Crimson Text, serif'
            }}
            contentEditable
            suppressContentEditableWarning>
            
            {title}
          </h1>

          {/* Content area */}
          <div
            className="text-[17px] leading-[1.75] text-neutral-800 outline-none min-h-[400px]"
            style={{
              fontFamily: 'Crimson Text, serif'
            }}
            contentEditable
            suppressContentEditableWarning
            dangerouslySetInnerHTML={{
              __html: editorContent
            }}
            onInput={(e) => setEditorContent(e.currentTarget.innerHTML)} />
          
        </div>
      </div>
    </div>);

}