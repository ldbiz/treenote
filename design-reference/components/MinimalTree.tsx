import React, { useState, Children } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { motion } from 'framer-motion';
interface TreeNode {
  id: string;
  title: string;
  children?: TreeNode[];
  isExpanded?: boolean;
}
interface MinimalTreeProps {
  isVisible: boolean;
  selectedNodeId: string;
  onSelectNode: (id: string) => void;
}
export function MinimalTree({
  isVisible,
  selectedNodeId,
  onSelectNode
}: MinimalTreeProps) {
  const [nodes, setNodes] = useState<TreeNode[]>([
  {
    id: '1',
    title: 'Morning Thoughts',
    isExpanded: true,
    children: [
    {
      id: '1-1',
      title: 'Meditation Notes'
    },
    {
      id: '1-2',
      title: 'Daily Intentions'
    }]

  },
  {
    id: '2',
    title: 'Project Ideas',
    isExpanded: true,
    children: [
    {
      id: '2-1',
      title: 'Zen Garden App'
    },
    {
      id: '2-2',
      title: 'Minimal Todo'
    }]

  },
  {
    id: '3',
    title: 'Reading Notes',
    isExpanded: false,
    children: [
    {
      id: '3-1',
      title: 'Deep Work'
    }]

  },
  {
    id: '4',
    title: 'Journal'
  }]
  );
  const toggleNode = (nodeId: string) => {
    const updateNodes = (items: TreeNode[]): TreeNode[] => {
      return items.map((node) => {
        if (node.id === nodeId) {
          return {
            ...node,
            isExpanded: !node.isExpanded
          };
        }
        if (node.children) {
          return {
            ...node,
            children: updateNodes(node.children)
          };
        }
        return node;
      });
    };
    setNodes(updateNodes(nodes));
  };
  const renderNode = (node: TreeNode, depth: number = 0) => {
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = node.id === selectedNodeId;
    return (
      <div key={node.id}>
        <div
          className={`group relative h-8 flex items-center cursor-pointer transition-colors ${isSelected ? 'border-l-2 border-emerald-500' : ''}`}
          style={{
            paddingLeft: `${depth * 16 + (isSelected ? 14 : 16)}px`
          }}
          onClick={() => {
            if (hasChildren) {
              toggleNode(node.id);
            }
            onSelectNode(node.id);
          }}>
          
          {hasChildren &&
          <div className="opacity-0 group-hover:opacity-100 transition-opacity mr-1">
              {node.isExpanded ?
            <ChevronDown size={14} className="text-neutral-400" /> :

            <ChevronRight size={14} className="text-neutral-400" />
            }
            </div>
          }
          {!hasChildren &&
          <div className="w-2 h-2 rounded-full bg-neutral-300 mr-2" />
          }
          <span
            className={`text-sm ${isSelected ? 'text-neutral-900 font-medium' : 'text-neutral-600'}`}>
            
            {node.title}
          </span>
        </div>
        {hasChildren && node.isExpanded &&
        <div>
            {node.children!.map((child) => renderNode(child, depth + 1))}
          </div>
        }
      </div>);

  };
  return (
    <motion.div
      initial={false}
      animate={{
        width: isVisible ? 220 : 0
      }}
      transition={{
        duration: 0.3,
        ease: 'easeInOut'
      }}
      className="bg-neutral-50 overflow-hidden flex-shrink-0">
      
      <div className="w-[220px] h-full py-6 px-3 overflow-y-auto">
        {nodes.map((node) => renderNode(node))}
      </div>
    </motion.div>);

}