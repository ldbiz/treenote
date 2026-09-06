import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
export function KeyboardHint() {
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    const hasSeenHint = localStorage.getItem('hasSeenKeyboardHint');
    if (!hasSeenHint) {
      setTimeout(() => setIsVisible(true), 1000);
      setTimeout(() => {
        setIsVisible(false);
        localStorage.setItem('hasSeenKeyboardHint', 'true');
      }, 6000);
    }
  }, []);
  if (!isVisible) return null;
  return (
    <motion.div
      initial={{
        opacity: 0,
        y: 20
      }}
      animate={{
        opacity: 1,
        y: 0
      }}
      exit={{
        opacity: 0,
        y: 20
      }}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-neutral-900 text-white px-4 py-2 rounded-lg text-sm shadow-lg">
      
      <span className="text-neutral-300">Tip:</span> Press{' '}
      <kbd className="px-1.5 py-0.5 bg-neutral-800 rounded text-xs mx-1">
        ⌘B
      </kbd>{' '}
      to toggle sidebar
    </motion.div>);

}